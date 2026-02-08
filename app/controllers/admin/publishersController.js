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

    res.json({ publishers: r.rows });
  } catch (err) {
    console.error("❌ /admin/publishers error:", err);
    res.status(500).json({ error: "publishers error" });
  }
}
