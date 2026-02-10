import { Router } from "express";

import { adminLogin } from "../controllers/admin/authController.js";

import * as orders from "../controllers/admin/ordersController.js";
import * as creatives from "../controllers/admin/creativesController.js";
import * as mediation from "../controllers/admin/mediationController.js";
import * as publishers from "../controllers/admin/publishersController.js";
import * as providersAvail from "../controllers/admin/providersAvailabilityController.js";
import * as stats from "../controllers/admin/statsController.js";

const router = Router();

// helper: выбирает существующий handler или падает с понятной ошибкой
function pick(mod, names, routeLabel) {
  for (const n of names) {
    if (typeof mod?.[n] === "function") return mod[n];
  }
  throw new Error(
    `Missing handler for ${routeLabel}. Expected one of: ${names.join(", ")}. ` +
    `Available exports: ${Object.keys(mod || {}).join(", ")}`
  );
}

// ===================
// AUTH
// ===================
router.post("/admin/auth/login", adminLogin);

// ===================
// ORDERS
// exports: createCreativeOrder, listOrders, orderDetail, pauseOrder, resumeOrder, stopOrder
// ===================
router.get(
  "/admin/orders",
  pick(orders, ["listOrders"], "GET /admin/orders")
);

router.get(
  "/admin/orders/:id",
  pick(orders, ["orderDetail"], "GET /admin/orders/:id")
);

router.post(
  "/admin/orders",
  pick(orders, ["createCreativeOrder"], "POST /admin/orders")
);

router.post(
  "/admin/orders/:id/pause",
  pick(orders, ["pauseOrder"], "POST /admin/orders/:id/pause")
);

router.post(
  "/admin/orders/:id/resume",
  pick(orders, ["resumeOrder"], "POST /admin/orders/:id/resume")
);

router.post(
  "/admin/orders/:id/stop",
  pick(orders, ["stopOrder"], "POST /admin/orders/:id/stop")
);

// ===================
// CREATIVES
// (если имена другие — pick сам скажет какие есть)
// ===================
router.get(
  "/admin/creatives",
  pick(creatives, ["listCreatives", "getCreatives"], "GET /admin/creatives")
);

router.post(
  "/admin/creatives/:id/approve",
  pick(creatives, ["approveCreative", "approve"], "POST /admin/creatives/:id/approve")
);

router.post(
  "/admin/creatives/:id/reject",
  pick(creatives, ["rejectCreative", "reject"], "POST /admin/creatives/:id/reject")
);

// ===================
// MEDIATION
// ===================
router.get(
  "/admin/mediation",
  pick(mediation, ["getMediation", "getConfig"], "GET /admin/mediation")
);

router.post(
  "/admin/mediation",
  pick(mediation, ["saveMediation", "saveConfig"], "POST /admin/mediation")
);

// ===================
// PROVIDERS
// ===================
router.get(
  "/admin/providers",
  pick(providersAvail, ["getProviders", "listProviders"], "GET /admin/providers")
);

router.post(
  "/admin/providers",
  pick(providersAvail, ["saveProviders", "updateProviders"], "POST /admin/providers")
);

// ===================
// PUBLISHERS
// ===================
router.get(
  "/admin/publishers",
  pick(publishers, ["getPublishers", "listPublishers"], "GET /admin/publishers")
);

// ===================
// STATS
// ===================
router.get("/admin/stats", stats.adminStats);
router.get("/admin/stats/providers", stats.adminStatsProviders);

export default router;
export { router };
