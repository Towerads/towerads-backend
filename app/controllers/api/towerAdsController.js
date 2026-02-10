import { v4 as uuidv4 } from "uuid";
import { pool } from "../../config/db.js";
import { ok, fail } from "../../utils/response.js";

// ✅ этот экспорт гарантирует, что модуль НЕ может иметь пустые exports
export const __tower_ok = true;

// --------------------
// HELPERS
// --------------------
async function requireActiveApiKey(api_key) {
  const r = await pool.query("SELECT status FROM api_keys WHERE api_key = $1", [
    api_key,
  ]);

  if (r.rowCount === 0) return { ok: false, error: "Invalid api_key" };
  if (r.rows[0].status !== "active")
    return { ok: false, error: "api_key inactive" };

  return { ok: true };
}

async function requireActivePlacement(api_key, placement_id) {
  const r = await pool.query(
    `
    SELECT id, ad_type, status
    FROM placements
    WHERE api_key = $1 AND id = $2
    `,
    [api_key, placement_id]
  );

  if (r.rowCount === 0) return { ok: false, error: "Invalid placement_id" };
  if (r.rows[0].status !== "active")
    return { ok: false, error: "placement paused" };

  return { ok: true, placement: r.rows[0] };
}

async function findPlacementByPublicKey(public_key) {
  const r = await pool.query(
    `
    SELECT id, api_key, ad_type, status
    FROM placements
    WHERE public_key = $1
    `,
    [public_key]
  );

  if (r.rowCount === 0)
    return { ok: false, error: "Invalid placement_public_key" };
  if (r.rows[0].status !== "active")
    return { ok: false, error: "placement paused" };

  return { ok: true, placement: r.rows[0] };
}

function getClientIp(req, user_data) {
  // 1) user_data.ip от SDK (если передают)
  if (user_data?.ip) return user_data.ip;

  // 2) Cloudflare (у тебя в логах есть)
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();

  // 3) X-Forwarded-For (берём первый)
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }

  return null;
}

async function pickUslAd(placement_id) {
  const r = await pool.query(
    `
    SELECT id, ad_type, media_url, click_url, duration, creative_id
    FROM ads
    WHERE placement_id = $1
      AND status = 'active'
      AND source = 'usl'
    ORDER BY last_shown_at NULLS FIRST, created_at DESC
    LIMIT 1
    `,
    [placement_id]
  );

  if (!r.rowCount) return null;

  // отметим показ для ротации
  await pool.query(`UPDATE ads SET last_shown_at = now() WHERE id = $1`, [
    r.rows[0].id,
  ]);

  return r.rows[0];
}

async function pickActiveOrderForCreative(creative_id) {
  if (!creative_id) return null;

  const r = await pool.query(
    `
    SELECT id, price_per_impression
    FROM creative_orders
    WHERE creative_id = $1::uuid
      AND status = 'active'
      AND impressions_left > 0
    ORDER BY created_at ASC
    LIMIT 1
    `,
    [creative_id]
  );

  if (!r.rowCount) return null;
  return r.rows[0];
}

// --------------------
// MEDIATION
// --------------------
async function decideProviders(placement_id) {
  const r = await pool.query(
    `
    SELECT mc.network
    FROM mediation_config mc
    LEFT JOIN mediation_provider_state ps
        ON ps.placement_id = mc.placement_id
        AND ps.network = mc.network
    WHERE mc.placement_id = $1
        AND mc.status = 'active'
        AND mc.traffic_percentage > 0
        AND (ps.exhausted_until IS NULL OR ps.exhausted_until <= now())
    ORDER BY mc.priority DESC, mc.id ASC
    `,
    [placement_id]
  );

  if (!r.rowCount) return ["tower"];

  const providers = r.rows.map((x) => x.network);

  const state = await pool.query(
    `
    SELECT last_network
    FROM mediation_state
    WHERE placement_id = $1
    `,
    [placement_id]
  );

  let start = 0;
  if (state.rowCount && state.rows[0].last_network) {
    const idx = providers.indexOf(state.rows[0].last_network);
    start = idx >= 0 ? (idx + 1) % providers.length : 0;
  }

  const ordered = [...providers.slice(start), ...providers.slice(0, start)];

  await pool.query(
    `
    INSERT INTO mediation_state (placement_id, last_network, last_shown_at)
    VALUES ($1, $2, now())
    ON CONFLICT (placement_id)
    DO UPDATE SET
      last_network = EXCLUDED.last_network,
      last_shown_at = now()
    `,
    [placement_id, ordered[0]]
  );

  return ordered;
}

// --------------------
// API ENDPOINTS
// --------------------
export async function requestAd(req, res) {
  try {
    const { api_key, placement_id, placement_public_key, user_data } =
      req.body || {};

    // режим 1: public_key (универсальный SDK)
    let resolvedApiKey = api_key;
    let resolvedPlacementId = placement_id;

    if (placement_public_key) {
      const pp = await findPlacementByPublicKey(placement_public_key);
      if (!pp.ok) return fail(res, pp.error, 400);

      resolvedApiKey = pp.placement.api_key;
      resolvedPlacementId = pp.placement.id;
    }

    // режим 2: старый api_key + placement_id (совместимость)
    if (!resolvedApiKey || !resolvedPlacementId) {
      return fail(
        res,
        "Missing api_key/placement_id or placement_public_key",
        400
      );
    }

    const k = await requireActiveApiKey(resolvedApiKey);
    if (!k.ok) return fail(res, k.error, 401);

    const p = await requireActivePlacement(resolvedApiKey, resolvedPlacementId);
    if (!p.ok) return fail(res, p.error, 400);

    // 1️⃣ WATERFALL провайдеров
    const providers = await decideProviders(resolvedPlacementId);
    const impression_id = "imp_" + uuidv4().replace(/-/g, "");

    // 🛡️ АНТИФРОД: защита от спама по session_id
    if (user_data?.session_id) {
      const dup = await pool.query(
        `
        SELECT 1
        FROM impressions
        WHERE session_id = $1
          AND created_at > now() - interval '30 seconds'
        `,
        [user_data.session_id]
      );
      if (dup.rowCount) {
        return fail(res, "Duplicate session", 429);
      }
    }

    const userIp = getClientIp(req, user_data);

    // 2️⃣ создаём impression (единый портал => source='tower')
    await pool.query(
      `
      INSERT INTO impressions
      (id, placement_id, status, source, network, providers, user_ip, device, os, session_id, user_agent, referer, captcha_verified)
      VALUES ($1, $2, 'requested', 'tower', NULL, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        impression_id,
        resolvedPlacementId,
        JSON.stringify(providers),
        userIp,
        user_data?.device || null,
        user_data?.os || null,
        user_data?.session_id || null,
        user_data?.user_agent || null,
        user_data?.referer || null,
        user_data?.captcha_verified ?? true,
      ]
    );

    // ✅ USL: если первый провайдер usl — отдаём креатив сразу
    const primary = providers[0];

    if (primary === "usl") {
      const ad = await pickUslAd(resolvedPlacementId);

      // если USL пуст — пусть SDK идёт дальше по waterfall
      if (!ad) return ok(res, { providers, impression_id });

      // order_id нужен твоей USL-логике в /impression (списание показов)
      const order = await pickActiveOrderForCreative(ad.creative_id);

      // фиксируем usl как winner, сохраняем ad/creative/order
      await pool.query(
        `
        UPDATE impressions
        SET ad_id = $1,
            creative_id = $2,
            order_id = $3,
            served_provider = 'usl',
            served_at = now(),
            network = 'usl',
            source = 'tower'
        WHERE id = $4
          AND status = 'requested'
        `,
        [ad.id, ad.creative_id || null, order?.id || null, impression_id]
      );

      // отмечаем попытку usl=filled (для аналитики)
      await pool.query(
        `
        INSERT INTO impression_attempts (impression_id, provider, result, error)
        VALUES ($1, 'usl', 'filled', NULL)
        `,
        [impression_id]
      );

      // click_url для фронта: редирект через наш трекер
      // (этот endpoint ниже в этом файле)
      const trackingClickUrl = `${req.protocol}://${req.get(
        "host"
      )}/api/tower-ads/click-redirect?impression_id=${encodeURIComponent(
        impression_id
      )}`;

      return ok(res, {
        providers,
        impression_id,
        provider: "usl",
        ad: {
          ad_id: ad.id,
          creative_id: ad.creative_id || null,
          type: ad.ad_type,
          media_url: ad.media_url,
          duration: ad.duration,
          target_url: ad.click_url,
          click_url: trackingClickUrl,
        },
      });
    }

    // по умолчанию (внешние сети) — как было
    return ok(res, { providers, impression_id });
  } catch (err) {
    console.error("❌ /request error:", err);
    return fail(res, "Server error", 500);
  }
}

export async function providerResultBatch(req, res) {
  try {
    const { impression_id, attempts, served_provider } = req.body || {};

    if (!impression_id) return fail(res, "Missing impression_id", 400);
    if (!Array.isArray(attempts)) return fail(res, "Missing attempts[]", 400);

    // ✅ сразу берём placement_id, чтобы писать provider_state
    const imp = await pool.query(
      `SELECT placement_id FROM impressions WHERE id = $1 AND status = 'requested'`,
      [impression_id]
    );
    if (!imp.rowCount) return fail(res, "Invalid impression state", 400);

    const placementId = imp.rows[0].placement_id;

    const NOFILL_LIMIT = 3;

    // 1) сохраняем все попытки + обновляем provider_state
    for (const a of attempts) {
      if (!a?.provider) continue;

      let result = (a.status || "error").toLowerCase();
      if (result === "no_fill" || result === "no-fill" || result === "nofill")
        result = "nofill";
      if (!["filled", "nofill", "error"].includes(result)) result = "error";

      await pool.query(
        `
        INSERT INTO impression_attempts
          (impression_id, provider, result, error)
        VALUES
          ($1, $2, $3, $4)
        `,
        [impression_id, a.provider, result, a.error || null]
      );

      if (result === "filled") {
        await pool.query(
          `
          INSERT INTO mediation_provider_state
            (placement_id, network, nofill_streak, last_result, last_error, exhausted_until, updated_at)
          VALUES ($1, $2, 0, 'filled', NULL, NULL, now())
          ON CONFLICT (placement_id, network)
          DO UPDATE SET
            nofill_streak = 0,
            last_result = 'filled',
            last_error = NULL,
            exhausted_until = NULL,
            updated_at = now()
          `,
          [placementId, a.provider]
        );
      } else if (result === "nofill") {
        await pool.query(
          `
          INSERT INTO mediation_provider_state
            (placement_id, network, nofill_streak, last_result, last_error, updated_at)
          VALUES ($1, $2, 1, 'nofill', $3, now())
          ON CONFLICT (placement_id, network)
          DO UPDATE SET
            nofill_streak = mediation_provider_state.nofill_streak + 1,
            last_result = 'nofill',
            last_error = EXCLUDED.last_error,
            updated_at = now()
          `,
          [placementId, a.provider, a.error || null]
        );

        await pool.query(
          `
          UPDATE mediation_provider_state
          SET exhausted_until = CASE
            WHEN nofill_streak >= $3 THEN (date_trunc('day', now()) + interval '1 day')
            ELSE exhausted_until
          END,
          updated_at = now()
          WHERE placement_id = $1 AND network = $2
          `,
          [placementId, a.provider, NOFILL_LIMIT]
        );
      } else {
        await pool.query(
          `
          INSERT INTO mediation_provider_state
            (placement_id, network, nofill_streak, last_result, last_error, updated_at)
          VALUES ($1, $2, 0, 'error', $3, now())
          ON CONFLICT (placement_id, network)
          DO UPDATE SET
            last_result = 'error',
            last_error = EXCLUDED.last_error,
            updated_at = now()
          `,
          [placementId, a.provider, a.error || null]
        );
      }
    }

    // 2) если был fill — фиксируем winner
    if (served_provider) {
      const allowed = attempts.map((a) => a.provider).filter(Boolean);

      if (!allowed.includes(served_provider)) {
        return fail(res, "served_provider not in attempts", 400);
      }

      await pool.query(
        `
        UPDATE impressions
        SET served_provider = $1,
            served_at = now(),
            network = $1
        WHERE id = $2
          AND status = 'requested'
        `,
        [served_provider, impression_id]
      );
    }

    return ok(res);
  } catch (e) {
    console.error("❌ /provider-result-batch error:", e);
    return fail(res, "Server error", 500);
  }
}

export async function impression(req, res) {
  try {
    const { impression_id } = req.body || {};
    if (!impression_id) return fail(res, "Missing impression_id", 400);

    const fraudCheck = await pool.query(
      `
      SELECT is_fraud, captcha_verified
      FROM impressions
      WHERE id = $1
        AND status = 'requested'
      `,
      [impression_id]
    );

    if (!fraudCheck.rowCount) return fail(res, "Invalid impression", 400);
    if (fraudCheck.rows[0].is_fraud) return fail(res, "Fraud impression", 403);
    if (!fraudCheck.rows[0].captcha_verified)
      return fail(res, "Captcha not verified", 403);

    // external (если у тебя есть старый поток) — оставить как совместимость
    const src = await pool.query(
      `SELECT source, served_provider FROM impressions WHERE id = $1`,
      [impression_id]
    );

    if (src.rowCount && src.rows[0].source === "external") {
      if (!src.rows[0].served_provider) {
        return ok(res, { filled: false });
      }

      await pool.query(
        `
        UPDATE impressions
        SET status = 'impression'
        WHERE id = $1
          AND status = 'requested'
        `,
        [impression_id]
      );

      return ok(res);
    }

    const meta = await pool.query(
      `
      SELECT
        i.source,
        i.network,
        i.order_id,
        co.price_per_impression,
        a.campaign_id,
        a.bid_cpm_usd,
        a.payout_cpm_usd
      FROM impressions i
      LEFT JOIN creative_orders co ON co.id = i.order_id
      LEFT JOIN ads a ON a.id = i.ad_id
      WHERE i.id = $1
        AND i.status = 'requested'
      `,
      [impression_id]
    );

    if (!meta.rowCount) return fail(res, "Invalid impression state", 400);

    // ✅ USL определяется по network, а не по source
    if (meta.rows[0].network === "usl") {
      const orderId = meta.rows[0].order_id;
      const pricePerImp = Number(meta.rows[0].price_per_impression || 0);

      if (!orderId)
        return fail(
          res,
          "Missing order_id for usl (no active creative_order)",
          400
        );

      await pool.query(
        `
        UPDATE impressions
        SET status = 'impression',
            revenue_usd = $1,
            cost_usd = 0
        WHERE id = $2
          AND status = 'requested'
        `,
        [pricePerImp, impression_id]
      );

      const left = await pool.query(
        `
        UPDATE creative_orders
        SET impressions_left = impressions_left - 1
        WHERE id = $1::uuid
          AND status = 'active'
          AND impressions_left > 0
        RETURNING impressions_left, creative_id
        `,
        [orderId]
      );

      if (!left.rowCount)
        return fail(res, "Order not active or no impressions left", 400);

      if (left.rows[0].impressions_left <= 0) {
        await pool.query(
          `UPDATE creative_orders SET status = 'completed' WHERE id = $1::uuid`,
          [orderId]
        );
        await pool.query(
          `UPDATE creatives SET status = 'frozen' WHERE id = $1::uuid`,
          [left.rows[0].creative_id]
        );
        await pool.query(
          `
          UPDATE ads
          SET status = 'paused'
          WHERE source = 'usl'
            AND creative_id = $1::uuid
          `,
          [left.rows[0].creative_id]
        );
      }

      return ok(res);
    }

    // остальные сети: CPM
    const bid = Number(meta.rows[0].bid_cpm_usd || 0);
    const payout = Number(meta.rows[0].payout_cpm_usd || 0);
    const revenue = bid / 1000;
    const cost = payout / 1000;

    const upd = await pool.query(
      `
      UPDATE impressions
      SET status = 'impression',
          revenue_usd = $1,
          cost_usd = $2
      WHERE id = $3
        AND status = 'requested'
      `,
      [revenue, cost, impression_id]
    );

    if (!upd.rowCount) return fail(res, "Invalid impression state", 400);

    const campaignId = meta.rows[0].campaign_id;
    if (campaignId) {
      await pool.query(
        `
        UPDATE campaigns
        SET spent_today_usd = spent_today_usd + $1,
            spent_total_usd = spent_total_usd + $1
        WHERE id = $2::uuid
        `,
        [revenue, campaignId]
      );
    }

    return ok(res);
  } catch (err) {
    console.error("❌ /impression error:", err);
    return fail(res, "Server error", 500);
  }
}

export async function complete(req, res) {
  try {
    const { impression_id } = req.body || {};
    if (!impression_id) return fail(res, "Missing impression_id", 400);

    await pool.query(
      `
      UPDATE impressions
      SET status = 'completed',
          completed_at = now()
      WHERE id = $1
      `,
      [impression_id]
    );

    return ok(res, { reward_granted: true });
  } catch (err) {
    console.error("❌ /complete error:", err);
    return fail(res, "Server error", 500);
  }
}

// Старый POST клик — оставляем как есть (если фронт умеет)
export async function click(req, res) {
  try {
    const { impression_id } = req.body || {};
    if (!impression_id) return fail(res, "Missing impression_id", 400);

    await pool.query(
      `
      UPDATE impressions
      SET status = 'clicked',
          clicked_at = now()
      WHERE id = $1
      `,
      [impression_id]
    );

    return ok(res, { click_tracked: true });
  } catch (err) {
    console.error("❌ /click error:", err);
    return fail(res, "Server error", 500);
  }
}

// ✅ Новый GET click-redirect (фронту проще: просто открыть ссылку)
export async function clickRedirect(req, res) {
  try {
    const impression_id = req.query?.impression_id;
    if (!impression_id) return res.status(400).send("Missing impression_id");

    // возьмём target_url из ads
    const r = await pool.query(
      `
      SELECT a.click_url
      FROM impressions i
      LEFT JOIN ads a ON a.id = i.ad_id
      WHERE i.id = $1
      `,
      [impression_id]
    );

    // фиксируем клик
    await pool.query(
      `
      UPDATE impressions
      SET status = 'clicked',
          clicked_at = now()
      WHERE id = $1
      `,
      [impression_id]
    );

    const target = r.rowCount ? r.rows[0].click_url : null;
    if (!target) return res.status(404).send("No target url");

    return res.redirect(302, target);
  } catch (err) {
    console.error("❌ /click-redirect error:", err);
    return res.status(500).send("Server error");
  }
}

export async function stats(req, res) {
  try {
    const { placement_id } = req.query;

    if (!placement_id) {
      return res.status(400).json({
        success: false,
        error: "Missing placement_id",
      });
    }

    const r = await pool.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE status = 'requested') AS requests,
        COUNT(*) FILTER (
          WHERE status IN ('impression','completed','clicked')
        ) AS impressions,
        COUNT(*) FILTER (WHERE status = 'clicked') AS clicks,
        SUM(revenue_usd) AS revenue,
        SUM(cost_usd) AS cost
      FROM impressions
      WHERE placement_id = $1
        AND source = 'tower'
      `,
      [placement_id]
    );

    const row = r.rows[0];
    const impressions = Number(row.impressions || 0);
    const revenue = Number(row.revenue || 0);

    return res.json({
      success: true,
      requests: Number(row.requests),
      impressions,
      clicks: Number(row.clicks),
      revenue,
      cost: Number(row.cost),
      ecpm: impressions ? (revenue / impressions) * 1000 : 0,
    });
  } catch (e) {
    console.error("❌ /stats error:", e);
    return res.status(500).json({ success: false, error: "stats error" });
  }
}
