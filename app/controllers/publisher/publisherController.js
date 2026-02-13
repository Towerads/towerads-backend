import { pool } from "../../config/db.js";
import crypto from "crypto";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ✅ минимальный хелпер, чтобы не падать если req.publisher не задан
function getPublisherId(req) {
  return req?.publisher?.publisherId ?? null;
}

// =========================
// SUMMARY
// =========================
export async function getSummary(req, res, next) {
  try {
    const publisherId = getPublisherId(req);

    if (!publisherId) {
      return res.json({
        publisher_id: null,
        balance: {
          frozen_usd: 0,
          available_usd: 0,
          locked_usd: 0,
          updated_at: null,
        },
        impressions_30d: 0,
        avg_cpm_net_30d: 0,
      });
    }

    await pool.query(
      `INSERT INTO publisher_balances (publisher_id)
       VALUES ($1)
       ON CONFLICT (publisher_id) DO NOTHING`,
      [publisherId]
    );

    const bal = await pool.query(
      `SELECT frozen_usd, available_usd, locked_usd, updated_at
       FROM publisher_balances
       WHERE publisher_id=$1`,
      [publisherId]
    );

    const stats30 = await pool.query(
      `
      SELECT
        COALESCE(SUM(impressions),0)::int AS impressions_30d,
        COALESCE(SUM(income_usd),0)::numeric(12,6) AS income_30d
      FROM placement_daily_stats
      WHERE publisher_id = $1
        AND date_key >= (now()::date - interval '29 days')
      `,
      [publisherId]
    );

    const impressions30 = Number(stats30.rows[0]?.impressions_30d || 0);
    const income30 = num(stats30.rows[0]?.income_30d || 0);

    const avgCpmNet30 =
      impressions30 > 0 ? (income30 / impressions30) * 1000 : 0;

    res.json({
      publisher_id: publisherId,
      balance: {
        frozen_usd: num(bal.rows[0]?.frozen_usd),
        available_usd: num(bal.rows[0]?.available_usd),
        locked_usd: num(bal.rows[0]?.locked_usd),
        updated_at: bal.rows[0]?.updated_at,
      },
      impressions_30d: impressions30,
      avg_cpm_net_30d: Number(avgCpmNet30.toFixed(6)),
    });
  } catch (e) {
    next(e);
  }
}

// =========================
// DAILY (ПО ТЗ: из placement_daily_stats)
// =========================
export async function getDaily(req, res, next) {
  try {
    const publisherId = getPublisherId(req);

    const placementId = String(req.query.placement_id || "").trim() || null;

    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();

    const daysParam = String(req.query.days || "30").toLowerCase();
    const isAll = daysParam === "all";
    const daysRaw = parseInt(daysParam, 10);
    const days = isAll
      ? null
      : Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 30, 1), 180);

    if (!publisherId) {
      return res.json({
        from: from || null,
        to: to || null,
        days: isAll ? "all" : days,
        placement_id: placementId,
        rows: [],
      });
    }

    const params = [publisherId];
    let where = `publisher_id = $1`;

    if (placementId) {
      params.push(placementId);
      where += ` AND placement_id = $${params.length}`;
    }

    if (from && to) {
      params.push(from, to);
      where += ` AND date_key >= $${params.length - 1}::date AND date_key <= $${params.length}::date`;
    } else if (days !== null) {
      params.push(days);
      where += ` AND date_key >= (now()::date - ($${params.length}::int - 1))`;
    }

    const r = await pool.query(
      `
      SELECT
        date_key::text AS day,
        SUM(impressions)::int AS impressions,
        SUM(income_usd)::numeric(12,6) AS net_usd
      FROM placement_daily_stats
      WHERE ${where}
      GROUP BY date_key
      ORDER BY date_key DESC
      `,
      params
    );

    const rows = r.rows.map((x) => ({
      day: x.day,
      impressions: Number(x.impressions || 0),
      gross_usd: "0",
      net_usd: String(x.net_usd || "0"),
      available_at: null,
      bucket: "available",
    }));

    return res.json({
      from: from || null,
      to: to || null,
      days: from && to ? null : isAll ? "all" : days,
      placement_id: placementId,
      rows,
    });
  } catch (e) {
    next(e);
  }
}

// =========================
// DASHBOARD (ALL ACTIVE+APPROVED PLACEMENTS, PERIOD from/to)
// =========================
export async function getDashboard(req, res, next) {
  try {
    const publisherId = getPublisherId(req);

    const from = String(req.query.from || "").trim(); // YYYY-MM-DD
    const to = String(req.query.to || "").trim(); // YYYY-MM-DD

    if (!publisherId) {
      return res.json({
        publisher_id: null,
        from: from || null,
        to: to || null,
        totals: { impressions: 0, income_usd: 0, cpm: 0 },
        today: { impressions: 0, income_usd: 0, cpm: 0 },
        yesterday: { impressions: 0, income_usd: 0, cpm: 0 },
      });
    }

    // default period = last 30 days
    let fromSql = from;
    let toSql = to;

    if (!fromSql || !toSql) {
      const q = await pool.query(
        `select (now()::date - interval '29 days')::date as f, (now()::date)::date as t`
      );
      fromSql = String(q.rows[0].f);
      toSql = String(q.rows[0].t);
    }

    // today/yesterday in MSK (если date_key режется по МСК)
    const msk = await pool.query(
      `select (now() at time zone 'Europe/Moscow')::date as today_msk,
              ((now() at time zone 'Europe/Moscow')::date - interval '1 day')::date as y_msk`
    );
    const todayMsk = String(msk.rows[0].today_msk);
    const yMsk = String(msk.rows[0].y_msk);

    // ВАЖНО: placements.publisher_id = integer, placement_daily_stats.publisher_id = bigint
    // Поэтому сравниваем так: p.publisher_id::bigint = s.publisher_id

    const totalQ = await pool.query(
      `
      SELECT
        COALESCE(SUM(s.impressions),0)::int AS impressions,
        COALESCE(SUM(s.income_usd),0)::numeric(12,6) AS income_usd
      FROM placement_daily_stats s
      JOIN placements p ON p.id = s.placement_id
      WHERE s.publisher_id = $1
        AND p.publisher_id::bigint = s.publisher_id
        AND p.status = 'active'
        AND p.moderation_status = 'approved'
        AND s.date_key >= $2::date
        AND s.date_key <= $3::date
      `,
      [publisherId, fromSql, toSql]
    );

    const totalImps = Number(totalQ.rows[0]?.impressions || 0);
    const totalIncome = num(totalQ.rows[0]?.income_usd || 0);
    const totalCpm = totalImps > 0 ? (totalIncome / totalImps) * 1000 : 0;

    const todayQ = await pool.query(
      `
      SELECT
        COALESCE(SUM(s.impressions),0)::int AS impressions,
        COALESCE(SUM(s.income_usd),0)::numeric(12,6) AS income_usd
      FROM placement_daily_stats s
      JOIN placements p ON p.id = s.placement_id
      WHERE s.publisher_id = $1
        AND p.publisher_id::bigint = s.publisher_id
        AND p.status = 'active'
        AND p.moderation_status = 'approved'
        AND s.date_key = $2::date
      `,
      [publisherId, todayMsk]
    );

    const todayImps = Number(todayQ.rows[0]?.impressions || 0);
    const todayIncome = num(todayQ.rows[0]?.income_usd || 0);
    const todayCpm = todayImps > 0 ? (todayIncome / todayImps) * 1000 : 0;

    const yQ = await pool.query(
      `
      SELECT
        COALESCE(SUM(s.impressions),0)::int AS impressions,
        COALESCE(SUM(s.income_usd),0)::numeric(12,6) AS income_usd
      FROM placement_daily_stats s
      JOIN placements p ON p.id = s.placement_id
      WHERE s.publisher_id = $1
        AND p.publisher_id::bigint = s.publisher_id
        AND p.status = 'active'
        AND p.moderation_status = 'approved'
        AND s.date_key = $2::date
      `,
      [publisherId, yMsk]
    );

    const yImps = Number(yQ.rows[0]?.impressions || 0);
    const yIncome = num(yQ.rows[0]?.income_usd || 0);
    const yCpm = yImps > 0 ? (yIncome / yImps) * 1000 : 0;

    return res.json({
      publisher_id: publisherId,
      from: fromSql,
      to: toSql,
      totals: {
        impressions: totalImps,
        income_usd: Number(totalIncome.toFixed(6)),
        cpm: Number(totalCpm.toFixed(6)),
      },
      today: {
        impressions: todayImps,
        income_usd: Number(todayIncome.toFixed(6)),
        cpm: Number(todayCpm.toFixed(6)),
      },
      yesterday: {
        impressions: yImps,
        income_usd: Number(yIncome.toFixed(6)),
        cpm: Number(yCpm.toFixed(6)),
      },
    });
  } catch (e) {
    next(e);
  }
}

// =========================
// PLACEMENTS
// =========================
function genId(prefix = "plc") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function pickAdType(v) {
  const s = String(v || "").toLowerCase();
  if (s === "rewarded_video" || s === "interstitial") return s;
  return null;
}

export async function listPlacements(req, res, next) {
  try {
    const publisherId = getPublisherId(req);

    if (!publisherId) {
      return res.json({ rows: [] });
    }

    const r = await pool.query(
      `
      SELECT
        id, name, domain, ad_type, status,
        moderation_status, public_key, approved_at, rejected_reason,
        created_at
      FROM placements
      WHERE publisher_id = $1
      ORDER BY created_at DESC
      `,
      [publisherId]
    );

    res.json({ rows: r.rows });
  } catch (e) {
    next(e);
  }
}

export async function createPlacement(req, res, next) {
  try {
    const publisherId = getPublisherId(req);

    if (!publisherId) {
      return res.status(401).json({ error: "Publisher not identified" });
    }

    const name = String(req.body?.name || "").trim();
    const domain = String(req.body?.domain || "").trim();
    const adType = pickAdType(req.body?.ad_type);

    if (!name) return res.status(400).json({ error: "name is required" });
    if (!domain) return res.status(400).json({ error: "domain is required" });
    if (!adType) {
      return res.status(400).json({
        error: "ad_type must be rewarded_video or interstitial",
      });
    }

    const keyRes = await pool.query(
      `SELECT api_key FROM api_keys WHERE status = 'active' LIMIT 1`
    );
    if (!keyRes.rowCount) {
      return res.status(500).json({ error: "No active api_key found" });
    }

    const id = genId("plc");
    const publicKey = crypto.randomBytes(16).toString("hex");

    const r = await pool.query(
      `
      INSERT INTO placements
        (id, api_key, name, ad_type, status, publisher_id, domain, moderation_status, public_key)
      VALUES
        ($1, $2, $3, $4, 'active', $5, $6, 'draft', $7)
      RETURNING *
      `,
      [id, keyRes.rows[0].api_key, name, adType, publisherId, domain, publicKey]
    );

    res.json({ placement: r.rows[0] });
  } catch (e) {
    next(e);
  }
}

export async function submitPlacement(req, res, next) {
  try {
    const publisherId = getPublisherId(req);
    const id = String(req.params.id);

    if (!publisherId) {
      return res.status(401).json({ error: "Publisher not identified" });
    }

    const r = await pool.query(
      `
      UPDATE placements
      SET moderation_status='pending'
      WHERE id=$1
        AND publisher_id=$2
        AND moderation_status IN ('draft','rejected')
      RETURNING id, moderation_status
      `,
      [id, publisherId]
    );

    if (!r.rowCount) {
      return res
        .status(404)
        .json({ error: "Placement not found or cannot be submitted" });
    }

    res.json({ success: true, placement: r.rows[0] });
  } catch (e) {
    next(e);
  }
}

// =========================
// PROVIDERS STATS (TMA)
// =========================
export async function getProvidersStats(req, res, next) {
  try {
    const publisherId = req.publisher?.publisherId;
    if (!publisherId) {
      return res.status(401).json({ error: "Publisher not identified" });
    }

    const daysParam = String(req.query.days || "30").toLowerCase();
    const isAll = daysParam === "all";
    const daysRaw = parseInt(daysParam, 10);
    const days = isAll
      ? null
      : Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 30, 1), 180);

    const providerExpr = `
      UPPER(
        COALESCE(
          NULLIF(i.served_provider, ''),
          NULLIF(i.network, ''),
          CASE
            WHEN i.providers IS NULL THEN NULL
            WHEN jsonb_typeof(i.providers) = 'object' THEN
              NULLIF(COALESCE(
                i.providers->>'served_provider',
                i.providers->>'provider',
                i.providers->>'network'
              ), '')
            WHEN jsonb_typeof(i.providers) = 'array' THEN
              NULLIF(COALESCE(
                i.providers->0->>'served_provider',
                i.providers->0->>'provider',
                i.providers->0->>'network'
              ), '')
            ELSE NULL
          END,
          'UNKNOWN'
        )
      )
    `;

    const q = await pool.query(
      `
      select
        ${providerExpr} as provider,
        count(*) filter (where i.status in ('impression','completed'))::int as impressions,
        count(*) filter (where i.status = 'clicked')::int as clicks
      from impressions i
      join placements p on p.id = i.placement_id
      where p.publisher_id = $1
        and p.moderation_status = 'approved'
        and i.is_fraud = false
        and ($2::int is null or i.created_at >= now() - ($2 || ' days')::interval)
      group by 1
      having ${providerExpr} <> 'UNKNOWN'
      order by impressions desc, provider asc
      `,
      [publisherId, days]
    );

    const rows = q.rows.map((r) => ({
      provider: String(r.provider || "UNKNOWN"),
      impressions: Number(r.impressions) || 0,
      clicks: Number(r.clicks) || 0,
      revenue_usd: 0,
      fill_rate: null,
    }));

    return res.json({
      days: isAll ? "all" : days,
      rows,
    });
  } catch (e) {
    next(e);
  }
}

// =========================
// SDK SCRIPT (TMA)
// =========================
export async function getSdkScript(req, res, next) {
  try {
    const publisherId = getPublisherId(req);
    if (!publisherId) {
      return res.status(401).json({ error: "Publisher not identified" });
    }

    const placementIdRaw = String(req.query.placement_id || "").trim();
    const placementId = placementIdRaw ? placementIdRaw : null;

    let r;

    if (placementId) {
      r = await pool.query(
        `
        SELECT id, name, public_key, ad_type
        FROM placements
        WHERE publisher_id = $1
          AND id = $2
          AND status = 'active'
          AND moderation_status = 'approved'
        LIMIT 1
        `,
        [publisherId, placementId]
      );
    } else {
      r = await pool.query(
        `
        SELECT id, name, public_key, ad_type
        FROM placements
        WHERE publisher_id = $1
          AND status = 'active'
          AND moderation_status = 'approved'
        ORDER BY approved_at DESC NULLS LAST, created_at DESC
        LIMIT 1
        `,
        [publisherId]
      );
    }

    if (!r.rowCount) {
      return res.status(404).json({ error: "NO_APPROVED_PLACEMENT" });
    }

    const p = r.rows[0];

    const sdkUrl =
      process.env.TOWERADS_SDK_URL ||
      "https://portal.yourdomain.com/sdk/tower-ads-v4.js";

    const script = `<!-- TowerAds Unified SDK -->
<script>
  (function (w, d, s, u, pk) {
    if (!pk) { console.error("TowerAds: placement public key missing"); return; }
    w.TowerAds = w.TowerAds || { q: [] };
    w.TowerAds.q.push({ type: "init", placementPublicKey: pk });

    var js = d.createElement(s);
    js.async = true;
    js.src = u;

    var first = d.getElementsByTagName(s)[0];
    first.parentNode.insertBefore(js, first);
  })(window, document, "script", "${sdkUrl}", "${p.public_key}");
</script>`;

    return res.json({
      placement_id: p.id,
      placement_name: p.name,
      placement_public_key: p.public_key,
      sdk_url: sdkUrl,
      script,
    });
  } catch (e) {
    next(e);
  }
}

// =========================
// ✅ ALIASES FOR ROUTES
// =========================
export const publisherSummary = getSummary;
export const publisherDaily = getDaily;
export const publisherProvidersStats = getProvidersStats;
export const publisherDashboard = getDashboard;


