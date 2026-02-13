// towerads-backend/app/controllers/admin/statsController.js
import { pool } from "../../config/db.js";

// =====================
// HELPERS
// =====================
function clampInt(v, def, min, max) {
  const n = parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function parseRange(req) {
  const from = String(req.query.from || "").trim(); // YYYY-MM-DD
  const to = String(req.query.to || "").trim(); // YYYY-MM-DD
  const days = clampInt(req.query.days, 30, 1, 365);

  // приоритет: from/to
  if (from && to) return { from, to, days: null };
  return { from: null, to: null, days };
}

// date_key c отсечкой 03:00 МСК (UTC+3):
// created_at + interval '3 hours' -> cast to date
const DATE_KEY_EXPR = `( (t.created_at + interval '3 hours')::date )`;

// =====================
// TOTAL STATS
// =====================
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

// =====================
// PROVIDERS STATS (старый, как у тебя)
// attempts = из impression_attempts
// revenue/cost = из impressions по served_provider
// =====================
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

// =====================================================
// ✅ NEW: PROVIDERS DAILY (по дням, отсечка 03:00 МСК)
// Endpoint: GET /admin/stats/providers/daily?from&to OR ?days=30
// Возвращает: rows[{ day, provider, filled,nofill,error, impressions,revenue,cost,profit,cpm }]
// =====================================================
export async function adminStatsProvidersDaily(req, res) {
  try {
    const { from, to, days } = parseRange(req);

    const params = [];
    let whereAttempts = `1=1`;
    let whereWins = `1=1`;

    if (from && to) {
      params.push(from, to);
      // фильтруем по date_key с отсечкой 03:00 МСК
      whereAttempts = `${DATE_KEY_EXPR.replaceAll("t.", "ia.")} >= $1::date AND ${DATE_KEY_EXPR.replaceAll("t.", "ia.")} <= $2::date`;
      whereWins = `${DATE_KEY_EXPR} >= $1::date AND ${DATE_KEY_EXPR} <= $2::date`;
    } else {
      params.push(days);
      whereAttempts = `${DATE_KEY_EXPR.replaceAll("t.", "ia.")} >= ( (now() + interval '3 hours')::date - ($1::int - 1) )`;
      whereWins = `${DATE_KEY_EXPR} >= ( (now() + interval '3 hours')::date - ($1::int - 1) )`;
    }

    const q = await pool.query(
      `
      WITH attempts AS (
        SELECT
          ${DATE_KEY_EXPR.replaceAll("t.", "ia.")} AS day,
          lower(ia.provider) AS provider,
          COUNT(*) FILTER (WHERE ia.result='filled')::int AS filled,
          COUNT(*) FILTER (WHERE ia.result='nofill')::int AS nofill,
          COUNT(*) FILTER (WHERE ia.result='error')::int  AS error
        FROM impression_attempts ia
        WHERE ${whereAttempts}
        GROUP BY 1,2
      ),
      wins AS (
        SELECT
          ${DATE_KEY_EXPR} AS day,
          lower(i.served_provider) AS provider,
          COUNT(*)::int AS impressions,
          COALESCE(SUM(i.revenue_usd),0)::numeric(12,6) AS revenue,
          COALESCE(SUM(i.cost_usd),0)::numeric(12,6) AS cost,
          (COALESCE(SUM(i.revenue_usd),0) - COALESCE(SUM(i.cost_usd),0))::numeric(12,6) AS profit
        FROM impressions i
        WHERE i.source='tower'
          AND i.served_provider IS NOT NULL
          AND i.status IN ('impression','completed','clicked')
          AND ${whereWins}
        GROUP BY 1,2
      ),
      all_keys AS (
        SELECT day, provider FROM attempts
        UNION
        SELECT day, provider FROM wins
      )
      SELECT
        k.day::text AS day,
        k.provider AS provider,

        COALESCE(a.filled,0)::int AS filled,
        COALESCE(a.nofill,0)::int AS nofill,
        COALESCE(a.error,0)::int  AS error,

        COALESCE(w.impressions,0)::int AS impressions,
        COALESCE(w.revenue,0)::numeric(12,6) AS revenue,
        COALESCE(w.cost,0)::numeric(12,6) AS cost,
        COALESCE(w.profit,0)::numeric(12,6) AS profit,

        CASE
          WHEN COALESCE(w.impressions,0) = 0 THEN 0
          ELSE (COALESCE(w.revenue,0) / COALESCE(w.impressions,0)) * 1000
        END::numeric(12,6) AS cpm
      FROM all_keys k
      LEFT JOIN attempts a ON a.day=k.day AND a.provider=k.provider
      LEFT JOIN wins w ON w.day=k.day AND w.provider=k.provider
      ORDER BY k.day DESC, k.provider ASC
      `,
      params
    );

    return res.json({
      from,
      to,
      days: from && to ? null : days,
      rows: q.rows,
    });
  } catch (e) {
    console.error("❌ /admin/stats/providers/daily error:", e);
    return res.status(500).json({ error: "stats error" });
  }
}

// =====================================================
// ✅ NEW: PLACEMENTS DAILY (по дням, отсечка 03:00 МСК)
// Endpoint: GET /admin/stats/placements/daily?from&to OR ?days=30
// + optional: ?placement_id=...
// Возвращает: rows[{ day, placement_id, placement_name, impressions, income, cpm }]
// =====================================================
export async function adminStatsPlacementsDaily(req, res) {
  try {
    const { from, to, days } = parseRange(req);

    const placementId = String(req.query.placement_id || "").trim() || null;

    const params = [];
    let where = `i.source='tower' AND i.status IN ('impression','completed','clicked')`;

    if (placementId) {
      params.push(placementId);
      where += ` AND i.placement_id = $${params.length}`;
    }

    if (from && to) {
      params.push(from, to);
      where += ` AND ${DATE_KEY_EXPR} >= $${params.length - 1}::date AND ${DATE_KEY_EXPR} <= $${params.length}::date`;
    } else {
      params.push(days);
      where += ` AND ${DATE_KEY_EXPR} >= ( (now() + interval '3 hours')::date - ($${params.length}::int - 1) )`;
    }

    const q = await pool.query(
      `
      SELECT
        ${DATE_KEY_EXPR}::text AS day,
        i.placement_id,
        p.name AS placement_name,
        COUNT(*)::int AS impressions,
        COALESCE(SUM(i.revenue_usd),0)::numeric(12,6) AS income_usd,
        CASE
          WHEN COUNT(*) = 0 THEN 0
          ELSE (COALESCE(SUM(i.revenue_usd),0) / COUNT(*)) * 1000
        END::numeric(12,6) AS cpm
      FROM impressions i
      JOIN placements p ON p.id = i.placement_id
      WHERE ${where}
      GROUP BY 1,2,3
      ORDER BY day DESC, placement_name ASC
      `,
      params
    );

    return res.json({
      from,
      to,
      days: from && to ? null : days,
      placement_id: placementId,
      rows: q.rows,
    });
  } catch (e) {
    console.error("❌ /admin/stats/placements/daily error:", e);
    return res.status(500).json({ error: "stats error" });
  }
}
