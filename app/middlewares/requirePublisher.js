import db from "../config/db.js";

/**
 * Требует, чтобы req.tgUserId был установлен requireTelegramUser.js
 * Маппинг:
 *  api_keys.user_id (tg id) -> api_keys.api_key
 *  placements.api_key -> placements.publisher_id
 */
export default async function requirePublisher(req, res, next) {
  try {
    const tgUserId = req.tgUserId;
    if (!tgUserId) {
      return res.status(401).json({ error: "Telegram user required" });
    }

    // 1) найдём api_key по tgUserId
    const keyRes = await db.query(
      `SELECT api_key
       FROM api_keys
       WHERE user_id=$1 AND status='active'
       LIMIT 1`,
      [String(tgUserId)]
    );

    if (!keyRes.rows.length) {
      return res.status(403).json({ error: "No active api_key for this Telegram user" });
    }

    const apiKey = keyRes.rows[0].api_key;

    // 2) найдём publisher_id по api_key
    const pubRes = await db.query(
      `SELECT publisher_id
       FROM placements
       WHERE api_key=$1 AND publisher_id IS NOT NULL
       LIMIT 1`,
      [apiKey]
    );

    if (!pubRes.rows.length) {
      return res.status(403).json({ error: "No publisher bound to this api_key" });
    }

    req.publisher = {
      publisherId: pubRes.rows[0].publisher_id,
      apiKey,
    };

    return next();
  } catch (e) {
    return next(e);
  }
}
