import { pool } from "../../config/db.js";
import { getOrCreateAdvertiserByTelegram } from "./advertiserController.js";

// можно убрать после того как всё заведётся
console.log("LOADED creativesController.js", import.meta.url);

export async function createCreative(req, res) {
  try {
    const {
      title,
      type,
      media_url,
      click_url,
      duration,
      campaign_id,
    } = req.body || {};

    if (!title || !type || !media_url || !click_url) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const advertiserId = await getOrCreateAdvertiserByTelegram(req.tgUserId);

    const r = await pool.query(
      `
      INSERT INTO creatives (
        advertiser_id,
        campaign_id,
        title,
        type,
        media_url,
        click_url,
        duration,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')
      RETURNING id, status
      `,
      [
        advertiserId,
        campaign_id || null,
        title,
        type,
        media_url,
        click_url,
        duration || null,
      ]
    );

    return res.json({ success: true, creative: r.rows[0] });
  } catch (err) {
    console.error("❌ create creative error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

export async function listCreatives(req, res) {
  try {
    const advertiserId = await getOrCreateAdvertiserByTelegram(req.tgUserId);

    const r = await pool.query(
      `
      SELECT
        id,
        title,
        type,
        media_url,
        click_url,
        duration,
        status,
        created_at
      FROM creatives
      WHERE advertiser_id = $1
      ORDER BY created_at DESC
      `,
      [advertiserId]
    );

    return res.json({ creatives: r.rows });
  } catch (err) {
    console.error("❌ list creatives error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

export async function submitCreative(req, res) {
  try {
    const advertiserId = await getOrCreateAdvertiserByTelegram(req.tgUserId);
    const creativeId = req.params.id;

    const r = await pool.query(
      `
      UPDATE creatives
      SET status = 'pending',
          updated_at = now()
      WHERE id = $1::uuid
        AND advertiser_id = $2
        AND status = 'draft'
      RETURNING id
      `,
      [creativeId, advertiserId]
    );

    if (!r.rowCount) {
      return res.status(400).json({ error: "Creative not in draft state" });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ submit creative error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

