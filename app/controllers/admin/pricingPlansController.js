import { pool } from "../../config/db.js";

export async function listPricingPlans(req, res) {
  try {
    const r = await pool.query(`
      SELECT id, name, impressions, price_usd
      FROM pricing_plans
      ORDER BY impressions ASC
    `);

    res.json({ plans: r.rows });
  } catch (err) {
    console.error("❌ pricing plans error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

