import express from "express";
import cors from "cors";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors());

const pool = new Pool({
  host: "towerads_postgres",
  port: 5432,
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
});

// ---------- helpers ----------

async function requireApiKey(api_key) {
  const r = await pool.query(
    "SELECT status FROM api_keys WHERE api_key=$1",
    [api_key]
  );
  if (r.rowCount === 0) return false;
  return r.rows[0].status === "active";
}

async function requirePlacement(api_key, placement_id) {
  const r = await pool.query(
    "SELECT status FROM placements WHERE api_key=$1 AND id=$2",
    [api_key, placement_id]
  );
  if (r.rowCount === 0) return false;
  return r.rows[0].status === "active";
}

// ---------- SDK endpoints ----------

app.post("/api/tower-ads/request", async (req, res) => {
  try {
    const { api_key, placement_id, user_data } = req.body;

    if (!api_key || !placement_id) {
      return res.status(400).json({ success: false, error: "Bad request" });
    }

    const okKey = await requireApiKey(api_key);
    if (!okKey) {
      return res.status(401).json({ success: false, error: "Invalid api_key" });
    }

    const okPlacement = await requirePlacement(api_key, placement_id);
    if (!okPlacement) {
      return res.status(400).json({ success: false, error: "Invalid placement_id" });
    }

    const percentRes = await pool.query(
      "SELECT traffic_percentage FROM mediation_config WHERE placement_id=$1 AND network='tower' AND status='active' ORDER BY priority DESC LIMIT 1",
      [placement_id]
    );

    const percent = percentRes.rows[0]?.traffic_percentage ?? 0;
    const roll = Math.floor(Math.random() * 100) + 1;

    if (roll > percent) {
      return res.json({ success: false, error: "No ad available" });
    }

    const adRes = await pool.query(
      "SELECT id, placement_id, ad_type, media_url, click_url, duration FROM ads WHERE placement_id=$1 AND status='active' ORDER BY priority DESC LIMIT 1",
      [placement_id]
    );

    if (adRes.rowCount === 0) {
      return res.json({ success: false, error: "No ad available" });
    }

    const ad = adRes.rows[0];
    const impression_id = "imp_" + uuidv4();

    await pool.query(
      `INSERT INTO impressions (id, ad_id, placement_id, user_ip, device, os, status)
       VALUES ($1,$2,$3,$4,$5,$6,'requested')`,
      [
        impression_id,
        ad.id,
        placement_id,
        user_data?.ip || null,
        user_data?.device || null,
        user_data?.os || null,
      ]
    );

    return res.json({
      success: true,
      ad: {
        ad_id: ad.id,
        ad_type: ad.ad_type,
        media_url: ad.media_url,
        click_url: ad.click_url,
        duration: ad.duration,
      },
      impression_id,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

app.post("/api/tower-ads/complete", async (req, res) => {
  try {
    const { impression_id } = req.body || {};
    if (!impression_id) {
      return res.status(400).json({ success: false, error: "Missing impression_id" });
    }

    await pool.query(
      "UPDATE impressions SET status='completed', completed_at=now() WHERE id=$1",
      [impression_id]
    );

    return res.json({ success: true, reward_granted: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

app.post("/api/tower-ads/click", async (req, res) => {
  try {
    const { impression_id } = req.body || {};
    if (!impression_id) {
      return res.status(400).json({ success: false, error: "Missing impression_id" });
    }

    await pool.query(
      "UPDATE impressions SET status='clicked', clicked_at=now() WHERE id=$1",
      [impression_id]
    );

    return res.json({ success: true, click_tracked: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// ---------- NEW: stats endpoint ----------
// GET /api/tower-ads/stats?api_key=...&placement_id=...
app.get("/api/tower-ads/stats", async (req, res) => {
  try {
    const api_key = req.query.api_key;
    const placement_id = req.query.placement_id;

    if (!api_key || !placement_id) {
      return res.status(400).json({ success: false, error: "Missing api_key or placement_id" });
    }

    const okKey = await requireApiKey(api_key);
    if (!okKey) {
      return res.status(401).json({ success: false, error: "Invalid api_key" });
    }

    const okPlacement = await requirePlacement(api_key, placement_id);
    if (!okPlacement) {
      return res.status(400).json({ success: false, error: "Invalid placement_id" });
    }

    const r = await pool.query(
      `SELECT
         COUNT(*)::int AS impressions,
         COUNT(*) FILTER (WHERE status='completed')::int AS completed,
         COUNT(*) FILTER (WHERE status='clicked')::int AS clicked
       FROM impressions
       WHERE placement_id=$1`,
      [placement_id]
    );

    const impressions = r.rows[0].impressions;
    const completed = r.rows[0].completed;
    const clicked = r.rows[0].clicked;

    const completion_rate = impressions ? Math.round((completed / impressions) * 100) : 0;
    const ctr = impressions ? Math.round((clicked / impressions) * 100) : 0;

    return res.json({
      success: true,
      placement_id,
      impressions,
      completed,
      clicked,
      completion_rate,
      ctr,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

// ---------- NEW: admin mediation update ----------
// POST /api/admin/mediation
// { api_key, placement_id, network, traffic_percentage, status?, priority? }
app.post("/api/admin/mediation", async (req, res) => {
  try {
    const { api_key, placement_id, network, traffic_percentage, status, priority } = req.body || {};

    if (!api_key || !placement_id || !network || traffic_percentage === undefined) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }

    const okKey = await requireApiKey(api_key);
    if (!okKey) {
      return res.status(401).json({ success: false, error: "Invalid api_key" });
    }

    const okPlacement = await requirePlacement(api_key, placement_id);
    if (!okPlacement) {
      return res.status(400).json({ success: false, error: "Invalid placement_id" });
    }

    const pct = Number(traffic_percentage);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ success: false, error: "traffic_percentage must be 0..100" });
    }

    const st = status || "active";
    const pr = Number.isFinite(Number(priority)) ? Number(priority) : 100;

    // update existing row; if not exists -> insert
    const upd = await pool.query(
      `UPDATE mediation_config
       SET traffic_percentage=$1, status=$2, priority=$3
       WHERE placement_id=$4 AND network=$5
       RETURNING id`,
      [pct, st, pr, placement_id, network]
    );

    if (upd.rowCount === 0) {
      await pool.query(
        `INSERT INTO mediation_config (placement_id, network, traffic_percentage, priority, status)
         VALUES ($1,$2,$3,$4,$5)`,
        [placement_id, network, pct, pr, st]
      );
    }

    return res.json({ success: true, updated: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: "Server error" });
  }
});

app.listen(3000, () => {
  console.log("íº€ TowerAds API running on http://localhost:3000");
});
