import { pool } from "../config/db.js";

const PUBLISHER_ID = 1; // общий кабинет на троих

export default async function requirePublisher(req, res, next) {
  try {
    const tgUserId = req.tgUserId;
    if (!tgUserId) {
      return res.status(401).json({ error: "Telegram user required" });
    }

    const r = await pool.query(
      `
      select role
      from publisher_members
      where publisher_id = $1 and tg_user_id = $2
      limit 1
      `,
      [PUBLISHER_ID, String(tgUserId)]
    );

    if (r.rowCount === 0) {
      return res.status(403).json({ error: "Publisher access denied" });
    }

    req.publisher = {
      publisherId: PUBLISHER_ID,
      role: r.rows[0].role,
    };

    return next();
  } catch (err) {
    return next(err);
  }
}
