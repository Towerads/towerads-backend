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
      "https://towerads-admin-web.onrender.com" // если будет
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
  const r = await pool.query(
    "SELECT status FROM api_keys WHERE api_key = $1",
    [api_key]
  );

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

  if (r.rowCount === 0)
    return { ok: false, error: "Invalid placement_id" };

  if (r.rows[0].status !== "active")
    return { ok: false, error: "placement paused" };

  return { ok: true, placement: r.rows[0] };
}

async function pickAd(placement_id, ad_type) {
  const r = await pool.query(
    `
    SELECT id, ad_type, media_url, click_url, duration
    FROM ads
    WHERE placement_id = $1
      AND ad_type = $2
      AND status = 'active'
    ORDER BY last_shown_at NULLS FIRST
    LIMIT 1
    `,
    [placement_id, ad_type]
  );

  return r.rowCount ? r.rows[0] : null;
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

    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
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
      "UPDATE admin_users SET last_login_at = now() WHERE id = $1",
      [admin.id]
    );

    res.cookie("admin_token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ admin login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


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

    await pool.query(
      "UPDATE ads SET last_shown_at = now() WHERE id = $1",
      [ad.id]
    );

    const impression_id = "imp_" + uuidv4().replace(/-/g, "");

    await pool.query(
      `
      INSERT INTO impressions
      (id, ad_id, placement_id, user_ip, device, os, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'requested')
      `,
      [
        impression_id,
        ad.id,
        placement_id,
        user_data?.ip || null,
        user_data?.device || null,
        user_data?.os || null,
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
    if (!impression_id)
      return fail(res, "Missing impression_id", 400);

    const r = await pool.query(
      `
      UPDATE impressions i
      SET status = 'impression',
          revenue_usd = a.bid_cpm_usd / 1000,
          cost_usd = a.payout_cpm_usd / 1000
      FROM ads a
      WHERE i.id = $1
        AND i.ad_id = a.id
        AND i.status = 'requested'
      RETURNING a.campaign_id, a.bid_cpm_usd
      `,
      [impression_id]
    );

    if (!r.rowCount)
      return fail(res, "Invalid impression state", 400);

    const revenue = r.rows[0].bid_cpm_usd / 1000;

    await pool.query(
      `
      UPDATE campaigns
      SET spent_today_usd = spent_today_usd + $1,
          spent_total_usd = spent_total_usd + $1
      WHERE id = $2
      `,
      [revenue, r.rows[0].campaign_id]
    );

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
    if (!impression_id)
      return fail(res, "Missing impression_id", 400);

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
    if (!impression_id)
      return fail(res, "Missing impression_id", 400);

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
      WHERE placement_id = $1
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
    WHERE placement_id = $1
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
    WHERE placement_id = $2 AND network = $3
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
    WHERE placement_id = $2 AND network = $3
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
