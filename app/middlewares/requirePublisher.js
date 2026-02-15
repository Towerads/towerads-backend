import { pool } from "../config/db.js";

export default async function requirePublisher(req, res, next) {
  try {
    const tgUserId = req.tgUserId;
    if (!tgUserId) {
      return res.status(401).json({ error: "Telegram user required" });
    }

    // Берём publisher_id и роль по tg_user_id
    // Если у пользователя есть доступ к нескольким publisher_id — пока берём первый.
    const r = await pool.query(
      `
      select publisher_id, role
      from publisher_members
      where tg_user_id = $1
      order by publisher_id asc
      limit 1
      `,
      [String(tgUserId)]
    );

    if (r.rowCount === 0) {
      return res.status(403).json({ error: "Publisher access denied" });
    }

    req.publisher = {
      publisherId: Number(r.rows[0].publisher_id),
      role: r.rows[0].role,
    };

    return next();
  } catch (err) {
    return next(err);
  }
}

