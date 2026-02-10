import { Router } from "express";

import { adminLogin } from "../controllers/admin/authController.js";

import * as orders from "../controllers/admin/ordersController.js";
import * as creatives from "../controllers/admin/creativesController.js";
import * as mediation from "../controllers/admin/mediationController.js";
import * as publishers from "../controllers/admin/publishersController.js";
import * as providersAvail from "../controllers/admin/providersAvailabilityController.js";
import * as stats from "../controllers/admin/statsController.js";

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
// ORDERS (по твоему логу exports точно такие)
// exports: createCreativeOrder, listOrders, orderDetail, pauseOrder, resumeOrder, stopOrder
// ===================
router.get("/admin/orders", pickOr501(orders, ["listOrders"]));
router.get("/admin/orders/:id", pickOr501(orders, ["orderDetail"]));

router.post("/admin/orders", pickOr501(orders, ["createCreativeOrder"]));
router.post("/admin/orders/:id/pause", pickOr501(orders, ["pauseOrder"]));
router.post("/admin/orders/:id/resume", pickOr501(orders, ["resumeOrder"]));
router.post("/admin/orders/:id/stop", pickOr501(orders, ["stopOrder"]));

// ===================
// CREATIVES (по твоему логу)
// Available exports: approveCreative, listCreativesAdmin, pendingCreatives, rejectCreative
// ===================
router.get("/admin/creatives", (req, res, next) => {
  const status = String(req.query?.status || "").toLowerCase();
  if (status === "pending") {
    return pickOr501(creatives, ["pendingCreatives"])(req, res, next);
  }
  return pickOr501(creatives, ["listCreativesAdmin"])(req, res, next);
});

router.post(
  "/admin/creatives/:id/approve",
  pickOr501(creatives, ["approveCreative"])
);

router.post(
  "/admin/creatives/:id/reject",
  pickOr501(creatives, ["rejectCreative"])
);

// ===================
// MEDIATION
// (если имена не совпадут — будет 501, но сервер не упадёт)
// ===================
router.get("/admin/mediation", pickOr501(mediation, ["getMediation", "getConfig"]));
router.post("/admin/mediation", pickOr501(mediation, ["saveMediation", "saveConfig"]));

// ===================
// PROVIDERS
// ===================
router.get("/admin/providers", pickOr501(providersAvail, ["getProviders", "listProviders"]));
router.post("/admin/providers", pickOr501(providersAvail, ["saveProviders", "updateProviders"]));

// ===================
// PUBLISHERS
// ===================
router.get("/admin/publishers", pickOr501(publishers, ["getPublishers", "listPublishers"]));

// ===================
// STATS (эти точно есть у тебя)
// ===================
router.get("/admin/stats", stats.adminStats);
router.get("/admin/stats/providers", stats.adminStatsProviders);

export default router;
export { router };

