import { pool } from "../../config/db.js";

export async function adminMediationList(req, res) {
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
}

export async function adminMediationToggle(req, res) {
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
}

export async function adminMediationTraffic(req, res) {
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
}
