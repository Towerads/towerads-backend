import { pool } from "../../config/db.js";

// --------------------
// TOTAL STATS
// --------------------
export async function adminStats(req, res) {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'requested')  AS requests,
        COUNT(*) FILTER (WHERE status = 'impression') AS impressions,
        COUNT(*) FILTER (WHERE status = 'clicked')    AS clicks,
        COALESCE(SUM(revenue_usd), 0)                 AS revenue
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

// --------------------
// PROVIDERS STATS (ПО ТЗ)
// attempts = из impression_attempts
// revenue/cost = из impressions по served_provider (чтобы не умножалось на attempts)
// --------------------
export async function adminStatsProviders(req, res) {
  try {
    const { period = "today", from, to } = req.query;

    let whereSql = "";
    const params = [];

    if (from && to) {
      params.push(from, to);
      whereSql = `
        ia.created_at >= $1::date
        AND ia.created_at < ($2::date + interval '1 day')
      `;
    } else {
      let interval = "1 day";
      if (period === "7d") interval = "7 days";
      if (period === "30d") interval = "30 days";
      whereSql = `ia.created_at >= now() - interval '${interval}'`;
    }

    const r = await pool.query(
      `
      WITH attempts AS (
        SELECT
          ia.provider,
          COUNT(*) FILTER (WHERE ia.result = 'filled')::int AS filled,
          COUNT(*) FILTER (WHERE ia.result = 'nofill')::int AS nofill,
          COUNT(*) FILTER (WHERE ia.result = 'error')::int  AS error
        FROM impression_attempts ia
        WHERE ${whereSql}
        GROUP BY ia.provider
      ),
      wins AS (
        SELECT
          i.served_provider AS provider,
          COUNT(*)::int AS impressions,
          COALESCE(SUM(i.revenue_usd), 0)::numeric(12,6) AS revenue,
          COALESCE(SUM(i.cost_usd), 0)::numeric(12,6)    AS cost,
          (COALESCE(SUM(i.revenue_usd), 0) - COALESCE(SUM(i.cost_usd), 0))::numeric(12,6) AS profit
        FROM impressions i
        WHERE i.served_provider IS NOT NULL
          AND i.status IN ('impression','completed','clicked')
          AND i.source = 'tower'
        GROUP BY i.served_provider
      )
      SELECT
        a.provider,
        a.filled,
        a.nofill,
        a.error,

        COALESCE(w.impressions, 0)::int AS impressions,
        COALESCE(w.revenue, 0)::numeric(12,6) AS revenue,
        COALESCE(w.cost, 0)::numeric(12,6)    AS cost,
        COALESCE(w.profit, 0)::numeric(12,6)  AS profit,

        CASE
          WHEN COALESCE(w.impressions, 0) = 0 THEN 0
          ELSE (COALESCE(w.revenue, 0) / COALESCE(w.impressions, 0)) * 1000
        END::numeric(12,2) AS cpm

      FROM attempts a
      LEFT JOIN wins w ON w.provider = a.provider
      ORDER BY a.provider
      `,
      params
    );

    res.json({ stats: r.rows });
  } catch (e) {
    console.error("❌ /admin/stats/providers error:", e);
    res.status(500).json({ error: "stats error" });
  }
}
