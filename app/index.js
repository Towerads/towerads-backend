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
      "https://towerads-admin-web.onrender.com",
    ],
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// --------------------
// DATABASE
// --------------------
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

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
    WHERE api_key = $1
      AND id = $2::uuid
    `,
    [api_key, placement_id]
  );

  if (r.rowCount === 0) return { ok: false, error: "Invalid placement_id" };
  if (r.rows[0].status !== "active")
    return { ok: false, error: "placement paused" };

  return { ok: true, placement: r.rows[0] };
}

async function pickAd(placement_id, ad_type) {
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

  if (r.rowCount) return r.rows[0].id;

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

// --------------------
// ADMIN AUTH
// --------------------
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
      { id: admin.id, role: admin.role },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: "7d" }
    );

    await pool.query(
      "UPDATE admin_users SET last_login_at = now() WHERE id = $1::uuid",
      [admin.id]
    );

    res.json({ success: true, token });
  } catch (err) {
    console.error("❌ admin login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

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
// ADMIN: CREATE CREATIVE ORDER
// --------------------
app.post("/admin/creative-orders/create", requireAdmin, async (req, res) => {
  try {
    const { creative_id, impressions_total, price_usd } = req.body || {};

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

    res.json({ success: true, order_id: order.rows[0].id });
  } catch (err) {
    console.error("❌ create creative order error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// --------------------
// START SERVER
// --------------------
const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`🚀 TowerAds API running on port ${PORT}`);
});
