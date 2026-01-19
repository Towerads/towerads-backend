import express from "express";
import cors from "cors";
import pkg from "pg";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

const MIN_MARGIN_CPM = Number(process.env.MIN_MARGIN_CPM_USD || 0);
console.log("MIN_MARGIN_CPM =", MIN_MARGIN_CPM);

const { Pool } = pkg;

// --------------------
// APP
// --------------------
const app = express();
app.use(express.json());

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
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
    "SELECT id, ad_type, status FROM placements WHERE api_key = $1 AND id = $2",
    [api_key, placement_id]
  );
  if (r.rowCount === 0)
    return { ok: false, error: "Invalid placement_id" };
  if (r.rows[0].status !== "active")
    return { ok: false, error: "placement paused" };
  return { ok: true, placement: r.rows[0] };
}

async function getTowerPercent(placement_id) {
  const r = await pool.query(
    `
    SELECT traffic_percentage
    FROM mediation_config
    WHERE placement_id = $1
      AND network = 'tower'
      AND status = 'active'
    ORDER BY random()
    LIMIT 1
    `,
    [placement_id]
  );
  return r.rowCount ? Number(r.rows[0].traffic_percentage) : 0;
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
// HEALTH CHECK (Render)
// --------------------
app.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true });
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

    const p = await requireActivePlacement(api_key, placement_id);
    if (!p.ok) return fail(res, p.error, 400);


    const ad = await pickAd(placement_id, p.placement.ad_type);

    console.log(
      "[pickAd result]",
       "placement_id =", placement_id,
       "ad_type =", p.placement.ad_type,
       "ad =", ad
      );
      
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


// IMPRESSION (CPM начисление)

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
      RETURNING a.campaign_id,
                a.bid_cpm_usd,
                a.payout_cpm_usd
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
// START SERVER
// --------------------
const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`🚀 TowerAds API running on port ${PORT}`);
});
