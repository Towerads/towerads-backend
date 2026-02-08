import { pool } from "../../config/db.js";

export async function adminStats(req, res) {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'requested') AS requests,
        COUNT(*) FILTER (WHERE status = 'impression') AS impressions,
        COUNT(*) FILTER (WHERE status = 'clicked') AS clicks,
        COALESCE(SUM(revenue_usd), 0) AS revenue
      FROM impressions
    `);

    const row = r.rows[0];

    res.json({
      requests: Number(row.requests),
      impressions: Number(row.impressions),
      clicks: Number(row.clicks),
      revenue: Number(row.revenue),
    });
  } catch (e) {
    console.error("❌ /admin/stats error:", e);
    res.status(500).json({ error: "stats error" });
  }
}

export async function adminStatsProviders(req, res) {
  try {
    const { period = "today", from, to } = req.query;

    let whereSql = "";
    const params = [];

    if (from && to) {
      params.push(from, to);
      whereSql = `
        i.created_at >= $1::date
        AND i.created_at < ($2::date + interval '1 day')
      `;
    } else {
      let interval = "1 day";
      if (period === "7d") interval = "7 days";
      if (period === "30d") interval = "30 days";

      whereSql = `i.created_at >= now() - interval '${interval}'`;
    }

    const r = await pool.query(
      `
      SELECT
        m.network AS provider,

        COUNT(i.id)::int AS impressions,

        COALESCE(SUM(i.revenue_usd), 0)::numeric(12,6) AS revenue,
        COALESCE(SUM(i.cost_usd), 0)::numeric(12,6)    AS cost,
        (COALESCE(SUM(i.revenue_usd), 0) - COALESCE(SUM(i.cost_usd), 0))::numeric(12,6) AS profit,

        CASE
          WHEN COUNT(i.id) = 0 THEN 0
          ELSE (COALESCE(SUM(i.revenue_usd), 0) / COUNT(i.id)) * 1000
        END::numeric(12,2) AS cpm

      FROM impressions i
      JOIN ads a ON a.id = i.ad_id
      JOIN mediation_config m ON m.placement_id = i.placement_id

      WHERE ${whereSql}
        AND i.status = 'impression'

      GROUP BY m.network
      ORDER BY m.network
      `,
      params
    );

    res.json({ stats: r.rows });
  } catch (e) {
    console.error("❌ /admin/stats/providers error:", e);
    res.status(500).json({ error: "stats error" });
  }
}

