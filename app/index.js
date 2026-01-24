import express from "express";
import cors from "cors";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { requireAdmin } from "./middlewares/adminAuth.js";
import cookieParser from "cookie-parser";

dotenv.config();

const MIN_MARGIN_CPM = Number(process.env.MIN_MARGIN_CPM_USD || 0);
console.log("MIN_MARGIN_CPM =", MIN_MARGIN_CPM);

const { Pool } = pkg;

// --------------------
// APP
// --------------------
const app = express();

app.use(express.json());
app.use(cookieParser());

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://towerads-admin-web.onrender.com", // если будет
    ],
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// --------------------
// DATABASE (Render-ready)
// --------------------
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

// Проверка соединения с БД при старте
pool
  .query("SELECT 1")
  .then(() => console.log("✅ PostgreSQL connected"))
  .catch((err) => console.error("❌ PostgreSQL connection error:", err));

// --------------------
// HELPERS
// --------------------
function ok(res, body = {}) {
  res.json({ success: true, ...body });
}

function fail(res, error = "No ad available", code = 200) {
  res.status(code).json({ success: false, error });
}

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
    WHERE api_key = $1 AND id = $2::uuid
    `,
    [api_key, placement_id]
  );

  if (r.rowCount === 0) return { ok: false, error: "Invalid placement_id" };

  if (r.rows[0].status !== "active")
    return { ok: false, error: "placement paused" };

  return { ok: true, placement: r.rows[0] };
}

async function pickAd(placement_id, ad_type) {
  // 1) Сначала пробуем USL
  const usl = await pool.query(
    `
    SELECT
      a.id,
      a.ad_type,
      c.media_url,
      c.click_url,
      c.duration,
      c.id AS creative_id,
      co.id AS order_id
    FROM ads a
    JOIN creatives c ON c.id = a.creative_id
    JOIN creative_orders co ON co.creative_id = c.id
    WHERE a.placement_id = $1::uuid
      AND a.ad_type = $2
      AND a.status = 'active'
      AND a.source = 'usl'
      AND c.status = 'approved'
      AND co.status = 'active'
      AND co.impressions_left > 0
    ORDER BY a.last_shown_at NULLS FIRST
    LIMIT 1
    `,
    [placement_id, ad_type]
  );

  if (usl.rowCount) {
    return { ...usl.rows[0], source: "usl" };
  }

  // 2) Fallback на external (как было, но с фильтром source)
  const ext = await pool.query(
    `
    SELECT id, ad_type, media_url, click_url, duration
    FROM ads
    WHERE placement_id = $1::uuid
      AND ad_type = $2
      AND status = 'active'
      AND source = 'external'
    ORDER BY last_shown_at NULLS FIRST
    LIMIT 1
    `,
    [placement_id, ad_type]
  );

  return ext.rowCount ? { ...ext.rows[0], source: "external" } : null;
}

async function getOrCreateAdvertiserByTelegram(tgUserId) {
  const r = await pool.query(
    `
    SELECT id
    FROM advertisers
    WHERE telegram_user_id = $1
    `,
    [String(tgUserId)]
  );

  if (r.rowCount) {
    return r.rows[0].id;
  }

  // технический email чтобы пройти NOT NULL + UNIQUE
  const email = `tg_${String(tgUserId)}@tg.local`;

  const created = await pool.query(
    `
    INSERT INTO advertisers (email, telegram_user_id, status)
    VALUES ($1, $2, 'active')
    RETURNING id
    `,
    [email, String(tgUserId)]
  );

  return created.rows[0].id;
}

// --------------------
// HEALTH CHECK
// --------------------
app.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true });
});

// ADMIN AUTH
app.post("/admin/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }

    const r = await pool.query(
      `
      SELECT id, email, password_hash, role, status
      FROM admin_users
      WHERE email = $1
      `,
      [email]
    );

    if (!r.rowCount) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const admin = r.rows[0];
    if (admin.status !== "active") {
      return res.status(403).json({ error: "Admin disabled" });
    }

    const okPass = await bcrypt.compare(password, admin.password_hash);
    if (!okPass) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign(
      {
        id: admin.id,
        role: admin.role,
      },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: "7d" }
    );

    await pool.query(
      "UPDATE admin_users SET last_login_at = now() WHERE id = $1::uuid",
      [admin.id]
    );

    res.json({
      success: true,
      token,
    });
  } catch (err) {
    console.error("❌ admin login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ====================

// --------------------
// ADMIN: CREATIVES MODERATION
// --------------------
app.get("/admin/creatives/pending", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        c.id,
        c.type,
        c.media_url,
        c.click_url,
        c.duration,
        c.created_at,
        a.email AS advertiser_email
      FROM creatives c
      JOIN advertisers a ON a.id = c.advertiser_id
      WHERE c.status = 'pending'
      ORDER BY c.created_at ASC
    `);

    res.json({ creatives: r.rows });
  } catch (err) {
    console.error("❌ pending creatives error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/admin/creatives/approve", requireAdmin, async (req, res) => {
  const { creative_id } = req.body || {};

  if (!creative_id) {
    return res.status(400).json({ error: "Missing creative_id" });
  }

  const r = await pool.query(
    `
    UPDATE creatives
    SET status = 'approved',
        reject_reason = NULL,
        updated_at = now()
    WHERE id = $1::uuid
      AND status = 'pending'
    RETURNING id
    `,
    [creative_id]
  );

  if (!r.rowCount) {
    return res.status(400).json({ error: "Creative not in pending state" });
  }

  res.json({ success: true });
});

app.post("/admin/creatives/reject", requireAdmin, async (req, res) => {
  const { creative_id, reason } = req.body || {};

  if (!creative_id || !reason) {
    return res.status(400).json({ error: "Missing creative_id or reason" });
  }

  const r = await pool.query(
    `
    UPDATE creatives
    SET status = 'rejected',
        reject_reason = $2,
        updated_at = now()
    WHERE id = $1::uuid
      AND status = 'pending'
    RETURNING id
    `,
    [creative_id, reason]
  );

  if (!r.rowCount) {
    return res.status(400).json({ error: "Creative not in pending state" });
  }

  res.json({ success: true });
});

// --------------------
// ADMIN: CREATE CREATIVE ORDER (START ADS)
// --------------------
app.post("/admin/creative-orders/create", requireAdmin, async (req, res) => {
  try {
    const { creative_id, impressions_total, price_usd } = req.body || {};

    if (!creative_id || !impressions_total || !price_usd) {
      return res.status(400).json({ error: "Missing fields" });
    }

    // проверяем, что креатив approved
    const cr = await pool.query(
      `
      SELECT id
      FROM creatives
      WHERE id = $1::uuid
        AND status = 'approved'
      `,
      [creative_id]
    );

    if (!cr.rowCount) {
      return res.status(400).json({ error: "Creative not approved" });
    }

    const pricePerImpression = price_usd / impressions_total;

    // создаём заказ
    const order = await pool.query(
      `
      INSERT INTO creative_orders (
        creative_id,
        impressions_total,
        impressions_left,
        price_usd,
        price_per_impression,
        status
      )
      VALUES ($1::uuid, $2, $2, $3, $4, 'active')
      RETURNING id
      `,
      [creative_id, impressions_total, price_usd, pricePerImpression]
    );

    // создаём ad, чтобы реклама начала крутиться
    await pool.query(
      `
      INSERT INTO ads (
        id,
        placement_id,
        ad_type,
        media_url,
        click_url,
        duration,
        status,
        source,
        creative_id
      )
      SELECT
        'usl_' || replace(gen_random_uuid()::text, '-', ''),
        p.id,
        p.ad_type,
        c.media_url,
        c.click_url,
        c.duration,
        'active',
        'usl',
        c.id
      FROM creatives c
      CROSS JOIN placements p
      WHERE c.id = $1::uuid
      LIMIT 1
      `,
      [creative_id]
    );

    res.json({
      success: true,
      order_id: order.rows[0].id,
    });
  } catch (err) {
    console.error("❌ create creative order error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// --------------------
// ADVERTISER (TG MINI APP)
// --------------------

// middleware: получить TG user id
function requireTelegramUser(req, res, next) {
  const tgUserId = req.header("X-TG-USER-ID");
  if (!tgUserId) {
    return res.status(401).json({ error: "Missing Telegram user id" });
  }
  req.tgUserId = tgUserId;
  next();
}

// 1️⃣ Создать креатив (draft)
app.post("/advertiser/creatives", requireTelegramUser, async (req, res) => {
  try {
    const { type, media_url, click_url, duration } = req.body || {};

    if (!type || !media_url || !click_url) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const advertiserId = await getOrCreateAdvertiserByTelegram(req.tgUserId);

    const r = await pool.query(
      `
      INSERT INTO creatives (
        advertiser_id,
        type,
        media_url,
        click_url,
        duration,
        status
      )
      VALUES ($1, $2, $3, $4, $5, 'draft')
      RETURNING id, status
      `,
      [advertiserId, type, media_url, click_url, duration || null]
    );

    res.json({ success: true, creative: r.rows[0] });
  } catch (err) {
    console.error("❌ create creative error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 2️⃣ Получить свои креативы
app.get("/advertiser/creatives", requireTelegramUser, async (req, res) => {
  try {
    const advertiserId = await getOrCreateAdvertiserByTelegram(req.tgUserId);

    const r = await pool.query(
      `
      SELECT id, type, media_url, click_url, duration, status, created_at
      FROM creatives
      WHERE advertiser_id = $1
      ORDER BY created_at DESC
      `,
      [advertiserId]
    );

    res.json({ creatives: r.rows });
  } catch (err) {
    console.error("❌ list creatives error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// 3️⃣ Отправить креатив на модерацию
app.post(
  "/advertiser/creatives/:id/submit",
  requireTelegramUser,
  async (req, res) => {
    try {
      const advertiserId = await getOrCreateAdvertiserByTelegram(req.tgUserId);
      const creativeId = req.params.id;

      const r = await pool.query(
        `
        UPDATE creatives
        SET status = 'pending',
            updated_at = now()
        WHERE id = $1::uuid
          AND advertiser_id = $2
          AND status = 'draft'
        RETURNING id
        `,
        [creativeId, advertiserId]
      );

      if (!r.rowCount) {
        return res.status(400).json({ error: "Creative not in draft state" });
      }

      res.json({ success: true });
    } catch (err) {
      console.error("❌ submit creative error:", err);
      res.status(500).json({ error: "Server error" });
    }
  }
);

// --------------------
// API ENDPOINTS
// --------------------
app.post("/api/tower-ads/request", async (req, res) => {
  try {
    const { api_key, placement_id, user_data } = req.body || {};

    if (!api_key || !placement_id) {
      return fail(res, "Missing api_key or placement_id", 400);
    }

    const k = await requireActiveApiKey(api_key);
    if (!k.ok) return fail(res, k.error, 401);

    const provider = await decideProvider(placement_id);
    if (provider !== "tower") {
      return ok(res, { provider });
    }

    const p = await requireActivePlacement(api_key, placement_id);
    if (!p.ok) return fail(res, p.error, 400);

    const ad = await pickAd(placement_id, p.placement.ad_type);

    if (!ad) return fail(res);

    await pool.query("UPDATE ads SET last_shown_at = now() WHERE id = $1", [
      ad.id,
    ]);

    const impression_id = "imp_" + uuidv4().replace(/-/g, "");

    await pool.query(
      `
      INSERT INTO impressions
      (id, ad_id, placement_id, user_ip, device, os, status, source, creative_id, order_id)
      VALUES ($1, $2, $3::uuid, $4, $5, $6, 'requested', $7, $8::uuid, $9::uuid)
      `,
      [
        impression_id,
        ad.id,
        placement_id,
        user_data?.ip || null,
        user_data?.device || null,
        user_data?.os || null,
        ad.source || "external",
        ad.creative_id || null,
        ad.order_id || null,
      ]
    );

    ok(res, {
      provider: "tower",
      ad: {
        ad_id: ad.id,
        ad_type: ad.ad_type,
        media_url: ad.media_url,
        click_url: ad.click_url,
        duration: ad.duration,
      },
      impression_id,
    });
  } catch (err) {
    console.error("❌ /request error:", err);
    fail(res, "Server error", 500);
  }
});

// --------------------
// IMPRESSION
// --------------------
app.post("/api/tower-ads/impression", async (req, res) => {
  try {
    const { impression_id } = req.body || {};
    if (!impression_id) return fail(res, "Missing impression_id", 400);

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

    ok(res);
  } catch (err) {
    console.error("❌ /impression error:", err);
    fail(res, "Server error", 500);
  }
});

// --------------------
// COMPLETE
// --------------------
app.post("/api/tower-ads/complete", async (req, res) => {
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

    ok(res, { reward_granted: true });
  } catch (err) {
    console.error("❌ /complete error:", err);
    fail(res, "Server error", 500);
  }
});

// --------------------
// CLICK
// --------------------
app.post("/api/tower-ads/click", async (req, res) => {
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

    ok(res, { click_tracked: true });
  } catch (err) {
    console.error("❌ /click error:", err);
    fail(res, "Server error", 500);
  }
});

// --------------------
// STATS
// --------------------
app.get("/api/tower-ads/stats", async (req, res) => {
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
      WHERE placement_id = $1::uuid
      `,
      [placement_id]
    );

    const row = r.rows[0];
    const impressions = Number(row.impressions || 0);
    const revenue = Number(row.revenue || 0);

    res.json({
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
    res.status(500).json({ success: false, error: "stats error" });
  }
});

// --------------------
// MEDIATION
// --------------------
async function decideProvider(placement_id) {
  const r = await pool.query(
    `
    SELECT network, traffic_percentage
    FROM mediation_config
    WHERE placement_id = $1::uuid
      AND status = 'active'
    `,
    [placement_id]
  );

  if (!r.rowCount) return "tower";

  const rand = Math.random() * 100;
  let acc = 0;

  for (const row of r.rows) {
    acc += Number(row.traffic_percentage);
    if (rand <= acc) return row.network;
  }

  return "tower";
}

app.get("/admin/mediation", requireAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT
      placement_id,
      network AS provider,
      status,
      traffic_percentage
    FROM mediation_config
    ORDER BY network
  `);

  res.json({ providers: r.rows });
});

app.post("/admin/mediation/toggle", requireAdmin, async (req, res) => {
  const { placement_id, provider, status } = req.body;

  if (!placement_id || !provider || !status) {
    return res.status(400).json({ error: "Missing fields" });
  }

  await pool.query(
    `
    UPDATE mediation_config
    SET status = $1
    WHERE placement_id = $2::uuid AND network = $3
    `,
    [status, placement_id, provider]
  );

  res.json({ success: true });
});

app.post("/admin/mediation/traffic", requireAdmin, async (req, res) => {
  const { placement_id, provider, traffic_percentage } = req.body;

  if (!placement_id || !provider || traffic_percentage === undefined) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const pct = Number(traffic_percentage);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return res.status(400).json({ error: "traffic_percentage must be 0..100" });
  }

  await pool.query(
    `
    UPDATE mediation_config
    SET traffic_percentage = $1
    WHERE placement_id = $2::uuid AND network = $3
    `,
    [pct, placement_id, provider]
  );

  res.json({ success: true });
});

// --------------------
// ADMIN DASHBOARD STATS
// --------------------
app.get("/admin/stats", requireAdmin, async (req, res) => {
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
});

app.get("/admin/stats/providers", requireAdmin, async (req, res) => {
  const period = req.query.period || "today";

  let interval = "1 day";
  if (period === "7d") interval = "7 days";
  if (period === "30d") interval = "30 days";

  const r = await pool.query(`
    SELECT
      m.network AS provider,
      COUNT(i.id) AS impressions,
      COALESCE(SUM(i.revenue_usd), 0) AS revenue
    FROM impressions i
    JOIN ads a ON a.id = i.ad_id
    JOIN mediation_config m ON m.placement_id = i.placement_id
    WHERE i.created_at >= now() - interval '${interval}'
    GROUP BY m.network
  `);

  res.json({ stats: r.rows });
});

// --------------------
// START SERVER
// --------------------
const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`🚀 TowerAds API running on port ${PORT}`);
});
