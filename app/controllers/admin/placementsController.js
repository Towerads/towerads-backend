import { pool } from "../../config/db.js";

// GET /admin/placements?status=pending|approved|rejected|all
export async function adminPlacements(req, res, next) {
  try {
    const status = String(req.query.status || "pending").toLowerCase();

    let whereSql = "";
    const params = [];

    if (status !== "all") {
      whereSql = "WHERE p.moderation_status = $1";
      params.push(status);
    }

    const r = await pool.query(
      `
      SELECT
        p.id, p.name, p.domain, p.ad_type,
        p.status,
        p.moderation_status, p.approved_at, p.rejected_reason,
        p.public_key,
        p.publisher_id,
        p.created_at
      FROM placements p
      ${whereSql}
      ORDER BY p.created_at DESC
      LIMIT 200
      `,
      params
    );

    res.json({ rows: r.rows });
  } catch (e) {
    next(e);
  }
}

// POST /admin/placements/:id/approve
export async function approvePlacement(req, res, next) {
  try {
    const id = String(req.params.id);

    const r = await pool.query(
      `
      UPDATE placements
      SET moderation_status='approved',
          approved_at=now(),
          rejected_reason=NULL
      WHERE id=$1
        AND moderation_status IN ('pending','rejected','draft')
      RETURNING id, moderation_status, approved_at
      `,
      [id]
    );

    if (!r.rowCount) {
      return res.status(404).json({ error: "Placement not found or cannot be approved" });
    }

    res.json({ success: true, placement: r.rows[0] });
  } catch (e) {
    next(e);
  }
}

// POST /admin/placements/:id/reject  { reason }
export async function rejectPlacement(req, res, next) {
  try {
    const id = String(req.params.id);
    const reason = String(req.body?.reason || "").trim();

    if (!reason) {
      return res.status(400).json({ error: "reason is required" });
    }

    const r = await pool.query(
      `
      UPDATE placements
      SET moderation_status='rejected',
          approved_at=NULL,
          rejected_reason=$2
      WHERE id=$1
        AND moderation_status IN ('pending','approved','draft')
      RETURNING id, moderation_status, rejected_reason
      `,
      [id, reason]
    );

    if (!r.rowCount) {
      return res.status(404).json({ error: "Placement not found or cannot be rejected" });
    }

    res.json({ success: true, placement: r.rows[0] });
  } catch (e) {
    next(e);
  }
}
