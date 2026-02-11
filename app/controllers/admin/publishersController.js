// towerads-backend/app/controllers/admin/publishersController.js
import { pool } from "../../config/db.js";

export async function adminPublishers(req, res) {
  try {
    const r = await pool.query(`
      SELECT
        p.id,
        p.name,

        COUNT(i.id) FILTER (WHERE i.status = 'impression')::int AS impressions,

        COALESCE(SUM(i.revenue_usd), 0)::numeric(12,6) AS revenue,
        COALESCE(SUM(i.cost_usd), 0)::numeric(12,6) AS cost,

        (COALESCE(SUM(i.revenue_usd), 0) -
         COALESCE(SUM(i.cost_usd), 0))::numeric(12,6) AS profit,

        CASE
          WHEN COUNT(i.id) FILTER (WHERE i.status = 'impression') = 0 THEN 0
          ELSE
            (COALESCE(SUM(i.revenue_usd), 0) /
             COUNT(i.id) FILTER (WHERE i.status = 'impression')) * 1000
        END::numeric(12,2) AS cpm

      FROM publishers p
      JOIN placements pl ON pl.publisher_id = p.id
      LEFT JOIN impressions i ON i.placement_id = pl.id
      GROUP BY p.id, p.name
      ORDER BY impressions DESC
    `);

    return res.json({ publishers: r.rows });
  } catch (err) {
    console.error("❌ /admin/publishers error:", err);
    return res.status(500).json({ error: "publishers error" });
  }
}

// ✅ NEW: /admin/publisher-placements
export async function adminPublisherPlacements(req, res) {
  try {
    const r = await pool.query(`
      SELECT
        pl.id,
        pl.name,
        pl.domain,
        pl.ad_type,
        pl.status,
        pl.moderation_status,
        pl.public_key,
        pl.approved_at,
        pl.rejected_reason,
        pl.created_at,

        pl.publisher_id,
        p.name AS publisher_username
      FROM placements pl
      LEFT JOIN publishers p ON p.id = pl.publisher_id
      ORDER BY pl.created_at DESC
    `);

    return res.json({ rows: r.rows });
  } catch (err) {
    console.error("❌ /admin/publisher-placements error:", err);
    return res.status(500).json({ error: "publisher placements error" });
  }
}
