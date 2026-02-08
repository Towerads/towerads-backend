import { Router } from "express";
import { requireAdmin } from "../middlewares/adminAuth.js";

// AUTH
import { adminLogin } from "../controllers/admin/authController.js";

// CREATIVES
import {
  pendingCreatives,
  approveCreative,
  rejectCreative,
  listCreativesAdmin
} from "../controllers/admin/creativesController.js";

// PRICING PLANS
import { listPricingPlans } from "../controllers/admin/pricingPlansController.js";

// ORDERS
import {
  createCreativeOrder,
  listOrders,
  orderDetail,
  pauseOrder,
  resumeOrder,
  stopOrder
} from "../controllers/admin/ordersController.js";

// MEDIATION
import {
  adminMediationList,
  adminMediationToggle,
  adminMediationTraffic
} from "../controllers/admin/mediationController.js";

// STATS
import {
  adminStats,
  adminStatsProviders
} from "../controllers/admin/statsController.js";

// PUBLISHERS
import { adminPublishers } from "../controllers/admin/publishersController.js";

// 🔴 PROVIDERS AVAILABILITY (NEW)
import {
  adminProvidersAvailability
} from "../controllers/admin/providersAvailabilityController.js";

const router = Router();

// ====================
// ADMIN AUTH
// ====================
router.post("/admin/auth/login", adminLogin);

// ====================
// CREATIVES
// ====================
router.get("/admin/creatives/pending", requireAdmin, pendingCreatives);
router.post("/admin/creatives/approve", requireAdmin, approveCreative);
router.post("/admin/creatives/reject", requireAdmin, rejectCreative);
router.get("/admin/creatives", requireAdmin, listCreativesAdmin);

// ====================
// PRICING PLANS
// ====================
router.get("/admin/pricing-plans", requireAdmin, listPricingPlans);

// ====================
// CREATIVE ORDERS
// ====================
router.post(
  "/admin/creative-orders/create",
  requireAdmin,
  createCreativeOrder
);

// ====================
// ORDERS
// ====================
router.get("/admin/orders", requireAdmin, listOrders);
router.get("/admin/orders/:id", requireAdmin, orderDetail);
router.post("/admin/orders/:id/pause", requireAdmin, pauseOrder);
router.post("/admin/orders/:id/resume", requireAdmin, resumeOrder);
router.post("/admin/orders/:id/stop", requireAdmin, stopOrder);

// ====================
// MEDIATION
// ====================
router.get("/admin/mediation", requireAdmin, adminMediationList);
router.post("/admin/mediation/toggle", requireAdmin, adminMediationToggle);
router.post("/admin/mediation/traffic", requireAdmin, adminMediationTraffic);

// ====================
// STATS
// ====================
router.get("/admin/stats", requireAdmin, adminStats);
router.get("/admin/stats/providers", requireAdmin, adminStatsProviders);

// ====================
// PROVIDERS AVAILABILITY 🔥
// ====================
router.get(
  "/admin/providers/availability",
  requireAdmin,
  adminProvidersAvailability
);

// ====================
// PUBLISHERS
// ====================
router.get("/admin/publishers", requireAdmin, adminPublishers);

export default router;
