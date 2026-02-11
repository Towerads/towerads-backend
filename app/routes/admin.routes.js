import { Router } from "express";

import { adminLogin } from "../controllers/admin/authController.js";

import * as orders from "../controllers/admin/ordersController.js";
import * as creatives from "../controllers/admin/creativesController.js";
import * as mediation from "../controllers/admin/mediationController.js";
import * as publishers from "../controllers/admin/publishersController.js";
import * as providersAvail from "../controllers/admin/providersAvailabilityController.js";
import * as stats from "../controllers/admin/statsController.js";
import * as earnings from "../controllers/admin/earningsController.js";

const router = Router();

/**
 * Не валит старт сервера.
 * Если хендлера нет — вернёт 501 и покажет, какие экспорты доступны.
 */
function pickOr501(mod, names) {
  for (const n of names) {
    if (typeof mod?.[n] === "function") return mod[n];
  }
  return (req, res) =>
    res.status(501).json({
      error: "Not implemented",
      expected: names,
      available: Object.keys(mod || {}),
    });
}

// ===================
// AUTH
// ===================
router.post("/admin/auth/login", adminLogin);

// ===================
// ORDERS
// exports: createCreativeOrder, listOrders, orderDetail, pauseOrder, resumeOrder, stopOrder
// ===================
router.get("/admin/orders", pickOr501(orders, ["listOrders"]));
router.get("/admin/orders/:id", pickOr501(orders, ["orderDetail"]));
router.post("/admin/orders", pickOr501(orders, ["createCreativeOrder"]));
router.post("/admin/orders/:id/pause", pickOr501(orders, ["pauseOrder"]));
router.post("/admin/orders/:id/resume", pickOr501(orders, ["resumeOrder"]));
router.post("/admin/orders/:id/stop", pickOr501(orders, ["stopOrder"]));

// ===================
// CREATIVES
// Available exports: approveCreative, listCreativesAdmin, pendingCreatives, rejectCreative
// ===================
router.get("/admin/creatives", (req, res, next) => {
  const status = String(req.query?.status || "").toLowerCase();
  if (status === "pending") {
    return pickOr501(creatives, ["pendingCreatives"])(req, res, next);
  }
  return pickOr501(creatives, ["listCreativesAdmin"])(req, res, next);
});
router.post("/admin/creatives/:id/approve", pickOr501(creatives, ["approveCreative"]));
router.post("/admin/creatives/:id/reject", pickOr501(creatives, ["rejectCreative"]));

// ===================
// MEDIATION
// Available exports: adminMediationList, adminMediationToggle, adminMediationTraffic
// ===================
router.get("/admin/mediation", pickOr501(mediation, ["adminMediationList"]));
router.post("/admin/mediation/toggle", pickOr501(mediation, ["adminMediationToggle"]));
router.post("/admin/mediation/traffic", pickOr501(mediation, ["adminMediationTraffic"]));

// ===================
// PROVIDERS
// (если будет 501 — в ответе увидишь available exports и подставим точные имена)
// ===================
router.get("/admin/providers", pickOr501(providersAvail, ["getProviders", "listProviders"]));
router.post("/admin/providers", pickOr501(providersAvail, ["saveProviders", "updateProviders"]));

// ===================
// PUBLISHERS
// Available exports: adminPublishers
// ===================
router.get("/admin/publishers", pickOr501(publishers, ["adminPublishers"]));

// ===================
// STATS
// ===================
router.get("/admin/stats", stats.adminStats);
router.get("/admin/stats/providers", stats.adminStatsProviders);

// ===================
// EARNINGS (manual jobs for MVP)
// ===================
// POST /admin/earnings/accrue?day=YYYY-MM-DD&revshare=0.7&freezeDays=5
router.post("/admin/earnings/accrue", pickOr501(earnings, ["adminAccrueDaily"]));
// POST /admin/earnings/unfreeze
router.post("/admin/earnings/unfreeze", pickOr501(earnings, ["adminUnfreezeDue"]));

export default router;
export { router };
