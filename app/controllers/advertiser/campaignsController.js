import { pool } from "../../config/db.js";
import { getOrCreateAdvertiserByTelegram } from "./advertiserController.js";

// 🔥 Диагностика: покажет, что Render загрузил именно этот файл
console.log("LOADED campaignsController.js", import.meta.url);

export async function createCampaign(req, res) {
  try {
    const { name, budget_usd } = req.body || {};

    if (!name || !budget_usd) {
      return res.status(400).json({ error: "name and budget_usd required" });
    }

    const advertiserId = await getOrCreateAdvertiserByTelegram(req.tgUserId);

    const r = await pool.query(
      `
      INSERT INTO campaigns (
        id,
        advertiser_id,
        name,
        budget_usd,
        status
      )
      VALUES (
        gen_random_uuid()::text,
        $1,
        $2,
        $3,
        'pending'
      )
      RETURNING *
      `,
      [advertiserId, name, Number(budget_usd)]
    );

    return res.json({ success: true, campaign: r.rows[0] });
  } catch (err) {
    console.error("❌ create campaign error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
