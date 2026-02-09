// towerads-backend/app/controllers/publisher/publisherController.js
const db = require("../../config/db");

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

exports.getSummary = async (req, res, next) => {
  try {
    const publisherId = req.publisher.publisherId;

    // гарантируем строку баланса
    await db.query(
      `INSERT INTO publisher_balances (publisher_id)
       VALUES ($1)
       ON CONFLICT (publisher_id) DO NOTHING`,
      [publisherId]
    );

    const bal = await db.query(
      `SELECT frozen_usd, available_usd, locked_usd, updated_at
       FROM publisher_balances
       WHERE publisher_id=$1`,
      [publisherId]
    );

    const impsRes = await db.query(
      `
      SELECT COUNT(*)::int AS impressions_30d
      FROM impressions i
      JOIN placements p ON p.id = i.placement_id
      WHERE p.publisher_id=$1
        AND p.moderation_status='approved'
        AND i.is_fraud=false
        AND i.status IN ('impression','completed')
        AND i.created_at >= now() - interval '30 days'
      `,
      [publisherId]
    );

    const cpmRes = await db.query(
      `
      SELECT
        CASE WHEN COALESCE(SUM((meta->>'impressions')::int),0) > 0
          THEN ROUND((SUM(amount_usd) / SUM((meta->>'impressions')::int)) * 1000, 6)
          ELSE 0 END AS avg_cpm_net_30d
      FROM publisher_ledger
      WHERE publisher_id=$1
        AND entry_type='EARN_NET_FROZEN'
        AND status IN ('posted','settled')
        AND earned_at >= now() - interval '30 days'
      `,
      [publisherId]
    );

    res.json({
      publisher_id: publisherId,
      balance: {
        frozen_usd: num(bal.rows[0]?.frozen_usd),
        available_usd: num(bal.rows[0]?.available_usd),
        locked_usd: num(bal.rows[0]?.locked_usd),
        updated_at: bal.rows[0]?.updated_at,
      },
      impressions_30d: impsRes.rows[0]?.impressions_30d ?? 0,
      avg_cpm_net_30d: num(cpmRes.rows[0]?.avg_cpm_net_30d),
    });
  } catch (e) {
    next(e);
  }
};

exports.getDaily = async (req, res, next) => {
  try {
    const publisherId = req.publisher.publisherId;
    const daysRaw = parseInt(req.query.days || "30", 10);
    const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 30, 1), 180);

    const r = await db.query(
      `
      SELECT
        (meta->>'day') AS day,
        SUM((meta->>'impressions')::int) AS impressions,
        SUM((meta->>'gross_usd')::numeric) AS gross_usd,
        SUM(amount_usd)::numeric(12,6) AS net_usd,
        MIN(available_at) AS available_at,
        CASE WHEN MIN(available_at) <= now() THEN 'available' ELSE 'frozen' END AS bucket
      FROM publisher_ledger
      WHERE publisher_id=$1
        AND entry_type='EARN_NET_FROZEN'
        AND status IN ('posted','settled')
        AND earned_at >= now() - ($2 || ' days')::interval
      GROUP BY (meta->>'day')
      ORDER BY (meta->>'day') DESC
      `,
      [publisherId, String(days)]
    );

    res.json({ days, rows: r.rows });
  } catch (e) {
    next(e);
  }
};
