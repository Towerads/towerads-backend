import { pool } from "../../config/db.js";

function intervalByPeriod(period) {
  if (period === "7d") return "7 days";
  if (period === "30d") return "30 days";
  return "1 day";
}

export async function adminProvidersAvailability(req, res) {
  try {
    const { period = "today" } = req.query;
    const interval = intervalByPeriod(period);

    const r = await pool.query(
      `
      SELECT
        ia.provider,

        COUNT(*) FILTER (WHERE ia.result = 'filled')::int AS filled,
        COUNT(*) FILTER (WHERE ia.result = 'nofill')::int AS nofill,
        COUNT(*) FILTER (WHERE ia.result = 'error')::int  AS error,

        MAX(ia.created_at) AS last_attempt_at,

        CASE
          WHEN COUNT(*) FILTER (WHERE ia.result = 'filled') = 0
               AND COUNT(*) FILTER (WHERE ia.result = 'nofill') >= 1
            THEN 'ended'
          WHEN COUNT(*) FILTER (WHERE ia.result = 'filled') > 0
            THEN 'ok'
          ELSE 'unknown'
        END AS availability

      FROM impression_attempts ia
      WHERE ia.created_at >= now() - interval '${interval}'
      GROUP BY ia.provider
      ORDER BY ia.provider
      `
    );

    res.json({
      success: true,
      period,
      providers: r.rows,
    });
  } catch (e) {
    console.error("❌ /admin/providers/availability error:", e);
    res.status(500).json({
      success: false,
      error: "availability error",
    });
  }
}

