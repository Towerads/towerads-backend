import { pool } from "../../config/db.js";
import { sendTelegramMessage } from "../../services/telegram.js";

export async function pendingCreatives(req, res) {
  try {
    const r = await pool.query(`
      SELECT
        c.id,
        CASE
          WHEN c.media_url ~* '\\.(jpg|jpeg|png|gif|jfif)$' THEN 'banner'
          WHEN c.media_url ~* '\\.(mp4|webm|mov)$' THEN 'video'
          ELSE c.type
        END AS type,
        c.media_url,
        c.click_url,
        c.title,
        c.duration,
        c.created_at,
        a.email AS advertiser_email
      FROM creatives c
      JOIN advertisers a ON a.id = c.advertiser_id
      WHERE c.status = 'pending'
      ORDER BY c.created_at ASC
    `);

    res.json({ creatives: r.rows });
  } catch (err) {
    console.error("❌ pending creatives error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

export async function approveCreative(req, res) {
  try {
    const { creative_id } = req.body || {};

    if (!creative_id) {
      return res.status(400).json({ error: "Missing creative_id" });
    }

    const r = await pool.query(
      `
      UPDATE creatives
      SET status = 'approved',
          reject_reason = NULL,
          updated_at = now()
      WHERE id = $1::uuid
        AND status = 'pending'
      RETURNING advertiser_id
      `,
      [creative_id]
    );

    if (!r.rowCount) {
      return res.status(400).json({ error: "Creative not in pending state" });
    }

    const advertiserId = r.rows[0].advertiser_id;

    const adv = await pool.query(
      `
      SELECT telegram_user_id
      FROM advertisers
      WHERE id = $1
      `,
      [advertiserId]
    );

    if (adv.rowCount && adv.rows[0].telegram_user_id) {
      const chatId = adv.rows[0].telegram_user_id;

      await sendTelegramMessage(
        chatId,
        "✅ Ваше рекламное видео прошло модерацию и **одобрено**.\n\nТеперь оно может быть запущено в показ."
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ approve creative error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

export async function rejectCreative(req, res) {
  try {
    const { creative_id, reason } = req.body || {};

    if (!creative_id || !reason) {
      return res.status(400).json({ error: "Missing creative_id or reason" });
    }

    const r = await pool.query(
      `
      UPDATE creatives
      SET status = 'rejected',
          reject_reason = $2,
          updated_at = now()
      WHERE id = $1::uuid
        AND status = 'pending'
      RETURNING advertiser_id
      `,
      [creative_id, reason]
    );

    if (!r.rowCount) {
      return res.status(400).json({ error: "Creative not in pending state" });
    }

    const advertiserId = r.rows[0].advertiser_id;

    const adv = await pool.query(
      `
      SELECT telegram_user_id
      FROM advertisers
      WHERE id = $1
      `,
      [advertiserId]
    );

    if (adv.rowCount && adv.rows[0].telegram_user_id) {
      const chatId = adv.rows[0].telegram_user_id;

      await sendTelegramMessage(
        chatId,
        `❌ Ваше рекламное видео **не прошло модерацию**.\n\nПричина отклонения:\n${reason}`
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ reject creative error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

export async function listCreativesAdmin(req, res) {
  try {
    const { status } = req.query;

    const r = await pool.query(
      `
      SELECT
        c.id,
        CASE
          WHEN c.media_url ~* '\\.(jpg|jpeg|png|gif|jfif)$' THEN 'banner'
          WHEN c.media_url ~* '\\.(mp4|webm|mov)$' THEN 'video'
          ELSE c.type
        END AS type,
        c.media_url,
        c.click_url,
        c.title,
        c.duration,
        c.status,
        c.created_at,
        a.email AS advertiser_email,
        co.price_usd AS price_usd
      FROM creatives c
      JOIN advertisers a ON a.id = c.advertiser_id
      LEFT JOIN creative_orders co
        ON co.creative_id = c.id
        AND co.status = 'active'
      WHERE ($1::text IS NULL OR c.status = $1)
      ORDER BY c.created_at DESC
      `,
      [status || null]
    );

    res.json({ creatives: r.rows });
  } catch (err) {
    console.error("❌ list creatives error:", err);
    res.status(500).json({ error: "Server error" });
  }
}
