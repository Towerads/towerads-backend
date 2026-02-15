import { pool } from "../config/db.js";
import crypto from "crypto";

export default async function requirePublisher(req, res, next) {
  const tgUserId = req.tgUserId;
  if (!tgUserId) return res.status(401).json({ error: "Telegram user required" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) уже есть membership?
    const m = await client.query(
      `
      select pm.publisher_id, pm.role
      from publisher_members pm
      where pm.tg_user_id = $1
      order by pm.publisher_id asc
      limit 1
      `,
      [String(tgUserId)]
    );

    if (m.rowCount > 0) {
      req.publisher = { publisherId: Number(m.rows[0].publisher_id), role: m.rows[0].role };
      await client.query("COMMIT");
      return next();
    }

    // 2) нет — создаём нового publisher под этого пользователя
    const apiKey = crypto.randomUUID(); // уникальный api_key для publishers
    const pubName = `publisher_${tgUserId}`;

    const p = await client.query(
      `
      insert into publishers (name, api_key, status, is_verified)
      values ($1, $2, 'active', false)
      returning id
      `,
      [pubName, apiKey]
    );

    const publisherId = Number(p.rows[0].id);

    await client.query(
      `
      insert into publisher_members (publisher_id, tg_user_id, role)
      values ($1, $2, 'owner')
      `,
      [publisherId, String(tgUserId)]
    );

    await client.query("COMMIT");

    req.publisher = { publisherId, role: "owner" };
    return next();
  } catch (err) {
    await client.query("ROLLBACK");
    return next(err);
  } finally {
    client.release();
  }
}

