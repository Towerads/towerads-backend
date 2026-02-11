// towerads-backend/app/controllers/admin/earningsController.js
import {
  accrueDailyEarnings,
  unfreezeDueEarnings,
} from "../../services/earningsService.js";

function clamp01(x, def = 0.7) {
  const n = Number(x);
  if (!Number.isFinite(n)) return def;
  return Math.max(0, Math.min(1, n));
}

export async function adminAccrueDaily(req, res) {
  try {
    const day = String(req.query.day || "").trim(); // YYYY-MM-DD
    if (!day) {
      return res.status(400).json({ error: "Missing ?day=YYYY-MM-DD" });
    }

    const revshare = clamp01(req.query.revshare, 0.7);
    const freezeDays = Math.max(
      0,
      Math.min(365, parseInt(String(req.query.freezeDays ?? "5"), 10) || 5)
    );

    const result = await accrueDailyEarnings({
      day,
      revshare,
      freezeDays,
    });

    return res.json({
      ok: true,
      day,
      revshare,
      freezeDays,
      ...result,
    });
  } catch (e) {
    console.error("❌ adminAccrueDaily:", e);
    return res.status(500).json({
      error: "accrue error",
      details: String(e?.message || e),
    });
  }
}

export async function adminUnfreezeDue(req, res) {
  try {
    const result = await unfreezeDueEarnings();
    return res.json({ ok: true, ...result });
  } catch (e) {
    console.error("❌ adminUnfreezeDue:", e);
    return res.status(500).json({
      error: "unfreeze error",
      details: String(e?.message || e),
    });
  }
}
