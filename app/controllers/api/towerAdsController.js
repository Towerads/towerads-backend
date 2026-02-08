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
  if (r.rows[0].status !== "active") return { ok: false, error: "api_key inactive" };

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
  if (r.rows[0].status !== "active") return { ok: false, error: "placement paused" };

  return { ok: true, placement: r.rows[0] };
}

// --------------------
// MEDIATION
// --------------------
async function decideProviders(placement_id) {
  const r = await pool.query(
    `
    SELECT network
    FROM mediation_config
    WHERE placement_id = $1
      AND status = 'active'
      AND traffic_percentage > 0
    ORDER BY priority DESC, id ASC
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
    const { api_key, placement_id, user_data } = req.body || {};

    if (!api_key || !placement_id) {
      return fail(res, "Missing api_key or placement_id", 400);
    }

    const k = await requireActiveApiKey(api_key);
    if (!k.ok) return fail(res, k.error, 401);

    const p = await requireActivePlacement(api_key, placement_id);
    if (!p.ok) return fail(res, p.error, 400);

    // 1️⃣ WATERFALL провайдеров
    const providers = await decideProviders(placement_id);
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

    // 2️⃣ создаём impression (пока НЕ знаем кто реально покажет)
    await pool.query(
      `
      INSERT INTO impressions
      (id, placement_id, status, source, network, providers, user_ip, device, os, session_id, user_agent, referer, captcha_verified)
      VALUES ($1, $2, 'requested', 'external', NULL, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        impression_id,
        placement_id,
        JSON.stringify(providers),
        user_data?.ip || null,
        user_data?.device || null,
        user_data?.os || null,
        user_data?.session_id || null,
        user_data?.user_agent || null,
        user_data?.referer || null,
        user_data?.captcha_verified ?? true,
      ]
    );

    // ✅ отвечаем waterfall
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

    const imp = await pool.query(
      `SELECT 1 FROM impressions WHERE id = $1 AND status = 'requested'`,
      [impression_id]
    );
    if (!imp.rowCount) return fail(res, "Invalid impression state", 400);

    // 1) сохраняем все попытки (для аналитики)
    for (const a of attempts) {
      if (!a?.provider) continue;

      let result = (a.status || "error").toLowerCase();
      if (result === "no_fill" || result === "no-fill" || result === "nofill") result = "nofill";
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
    }

    // 2) если был fill — обновляем impressions.served_provider + served_at
    if (served_provider) {
      const allowed = attempts.map((a) => a.provider).filter(Boolean);

      if (!allowed.includes(served_provider)) {
        return fail(res, "served_provider not in attempts", 400);
      }

      await pool.query(
        `
        UPDATE impressions
        SET served_provider = $1,
            served_at = now()
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

    // 🛡️ АНТИФРОД ПРОВЕРКА
    const fraudCheck = await pool.query(
      `
      SELECT is_fraud, captcha_verified
      FROM impressions
      WHERE id = $1
        AND status = 'requested'
      `,
      [impression_id]
    );

    if (!fraudCheck.rowCount) {
      return fail(res, "Invalid impression", 400);
    }

    if (fraudCheck.rows[0].is_fraud) {
      return fail(res, "Fraud impression", 403);
    }

    if (!fraudCheck.rows[0].captcha_verified) {
      return fail(res, "Captcha not verified", 403);
    }

    // 🔁 external — просто фиксируем impression
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

    if (meta.rows[0].source === "usl") {
      const orderId = meta.rows[0].order_id;
      const pricePerImp = Number(meta.rows[0].price_per_impression || 0);

      if (!orderId) return fail(res, "Missing order_id for usl", 400);

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

      if (!left.rowCount) return fail(res, "Order not active or no impressions left", 400);

      if (left.rows[0].impressions_left <= 0) {
        await pool.query(`UPDATE creative_orders SET status = 'completed' WHERE id = $1::uuid`, [orderId]);
        await pool.query(`UPDATE creatives SET status = 'frozen' WHERE id = $1::uuid`, [left.rows[0].creative_id]);
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
      RETURNING campaign_id
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
        COUNT(*) FILTER (WHERE status = 'impression') AS impressions,
        COUNT(*) FILTER (WHERE status = 'clicked') AS clicks,
        SUM(revenue_usd) AS revenue,
        SUM(cost_usd) AS cost
      FROM impressions
      WHERE placement_id = $1
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
