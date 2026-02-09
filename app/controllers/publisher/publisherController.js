// towerads-backend/app/controllers/publisher/publisherController.js
import { pool } from "../../config/db.js";
import crypto from "crypto";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function getSummary(req, res, next) {
  try {
    const publisherId = req.publisher.publisherId;

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

export async function getDaily(req, res, next) {
  try {
    const publisherId = req.publisher.publisherId;

    const daysParam = String(req.query.days || "30").toLowerCase();
    const isAll = daysParam === "all";
    const daysRaw = parseInt(daysParam, 10);
    const days = isAll
      ? null
      : Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 30, 1), 180);

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

function genId(prefix = "plc") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function pickAdType(v) {
  const s = String(v || "").toLowerCase();
  if (s === "rewarded_video" || s === "interstitial") return s;
  return null;
}

// GET /publisher/placements
export async function listPlacements(req, res, next) {
  try {
    const publisherId = req.publisher.publisherId;

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

// POST /publisher/placements
export async function createPlacement(req, res, next) {
  try {
    const publisherId = req.publisher.publisherId;

    const name = String(req.body?.name || "").trim();
    const domain = String(req.body?.domain || "").trim();
    const adType = pickAdType(req.body?.ad_type);

    if (!name) return res.status(400).json({ error: "name is required" });
    if (!domain) return res.status(400).json({ error: "domain is required" });
    if (!adType) {
      return res
        .status(400)
        .json({ error: "ad_type must be rewarded_video or interstitial" });
    }

    // берем любой активный api_key (SDK ключ)
    const keyRes = await pool.query(
      `SELECT api_key
       FROM api_keys
       WHERE status = 'active'
       LIMIT 1`
    );

    if (!keyRes.rowCount) {
      return res.status(500).json({ error: "No active api_key found" });
    }

    const apiKey = keyRes.rows[0].api_key;

    const id = genId("plc");
    const publicKey = crypto.randomBytes(16).toString("hex"); // ключ для SDK

    const r = await pool.query(
      `
      INSERT INTO placements
        (id, api_key, name, ad_type, status, publisher_id, domain, moderation_status, public_key)
      VALUES
        ($1, $2, $3, $4, 'active', $5, $6, 'draft', $7)
      RETURNING
        id, name, domain, ad_type, status, moderation_status, public_key, created_at
      `,
      [id, apiKey, name, adType, publisherId, domain, publicKey]
    );

    res.json({ placement: r.rows[0] });
  } catch (e) {
    next(e);
  }
}

// POST /publisher/placements/:id/submit
export async function submitPlacement(req, res, next) {
  try {
    const publisherId = req.publisher.publisherId;
    const id = String(req.params.id);

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
