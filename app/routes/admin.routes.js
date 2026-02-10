import { Router } from "express";

import { adminLogin } from "../controllers/admin/authController.js";

// controllers/admin/*
import * as orders from "../controllers/admin/ordersController.js";
import * as creatives from "../controllers/admin/creativesController.js";
import * as mediation from "../controllers/admin/mediationController.js";
import * as publishers from "../controllers/admin/publishersController.js";
import * as providersAvail from "../controllers/admin/providersAvailabilityController.js";
import * as stats from "../controllers/admin/statsController.js";

const router = Router();

// --- AUTH ---
router.post("/admin/auth/login", adminLogin);

// --- ORDERS (админка ждёт /admin/orders) ---
router.get("/admin/orders", orders.getOrders ?? orders.listOrders);
router.get("/admin/orders/:id", orders.getOrder ?? orders.getById);
router.patch("/admin/orders/:id", orders.updateOrder ?? orders.update);

// --- CREATIVES (админка бьёт /admin/creatives?status=pending) ---
router.get("/admin/creatives", creatives.getCreatives ?? creatives.listCreatives);
router.post("/admin/creatives/:id/approve", creatives.approveCreative ?? creatives.approve);
router.post("/admin/creatives/:id/reject", creatives.rejectCreative ?? creatives.reject);

// --- MEDIATION (админка бьёт /admin/mediation) ---
router.get("/admin/mediation", mediation.getMediation ?? mediation.getConfig);
router.post("/admin/mediation", mediation.saveMediation ?? mediation.saveConfig);

// --- PROVIDERS (у тебя экран “Провайдеры”) ---
router.get("/admin/providers", providersAvail.getProviders ?? providersAvail.listProviders);
router.post("/admin/providers", providersAvail.saveProviders ?? providersAvail.updateProviders);

// --- PUBLISHERS (админка бьёт /admin/publishers) ---
router.get("/admin/publishers", publishers.getPublishers ?? publishers.listPublishers);

// --- STATS (то, что уже было) ---
router.get("/admin/stats", stats.adminStats);
router.get("/admin/stats/providers", stats.adminStatsProviders);

export default router;
export { router };


