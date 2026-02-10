// towerads-backend/app/controllers/publisher/publisherController.js
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

    // ✅ не падаем, если middleware не проставил publisher
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

    const impsRes = await pool.query(
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

    const cpmRes = await pool.query(
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
}

// =========================
// DAILY
// =========================
export async function getDaily(req, res, next) {
  try {
    const publisherId = getPublisherId(req);

    const daysParam = String(req.query.days || "30").toLowerCase();
    const isAll = daysParam === "all";
    const daysRaw = parseInt(daysParam, 10);
    const days = isAll
      ? null
      : Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 30, 1), 180);

    // ✅ не падаем, если middleware не проставил publisher
    if (!publisherId) {
      return res.json({ days: isAll ? "all" : days, rows: [] });
    }

    const r = await pool.query(
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
        AND ($2::int IS NULL OR earned_at >= now() - ($2 || ' days')::interval)
      GROUP BY (meta->>'day')
      ORDER BY (meta->>'day') DESC
      `,
      [publisherId, days]
    );

    res.json({ days: isAll ? "all" : days, rows: r.rows });
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

    // ✅ не падаем, если middleware не проставил publisher
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
      
    // 1) Узнаем, есть ли колонка "provider" в impressions
    const col = await pool.query(
      `
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'impressions'
        and column_name = 'provider'
      limit 1
      `
    );
    const hasProviderCol = col.rowCount > 0;

    // 2) Формируем выражение "provider" безопасно
    //    если есть impressions.provider -> берём его
    //    иначе пытаемся взять из impressions.meta->>'provider' (если meta есть)
    const providerExpr = hasProviderCol
      ? "COALESCE(NULLIF(i.provider,''), 'UNKNOWN')"
      : "COALESCE(NULLIF(i.meta->>'provider',''), NULLIF(i.meta->>'network',''), 'UNKNOWN')";

    // 3) Агрегация по провайдерам на основе таблицы impressions
    //    - показы: status in ('impression','completed')
    //    - клики: status='click' (если у вас другое — скажи, поправим)
    const q = await pool.query(
      `
      select
        ${providerExpr} as provider,
        count(*) filter (where i.status in ('impression','completed'))::int as impressions,
        count(*) filter (where i.status = 'click')::int as clicks
      from impressions i
      join placements p on p.id = i.placement_id
      where p.publisher_id = $1
        and p.moderation_status = 'approved'
        and i.is_fraud = false
        and ($2::int is null or i.created_at >= now() - ($2 || ' days')::interval)
      group by 1
      order by 1
      `,
      [publisherId, days]
    );

    // 4) Доход по провайдерам: если у вас нет разметки дохода по провайдерам,
    //    возвращаем 0 (UI не будет краснеть)
    const rows = q.rows.map((r) => ({
      provider: String(r.provider || "UNKNOWN").toUpperCase(),
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
// ✅ ALIASES FOR ROUTES (FIX)
// =========================
export const publisherSummary = getSummary;
export const publisherDaily = getDaily;
export const publisherProvidersStats = getProvidersStats;

