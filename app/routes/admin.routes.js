import { Router } from "express";
import { adminLogin } from "../controllers/admin/authController.js";
import {
  adminStats,
  adminStatsProviders,
} from "../controllers/admin/statsController.js";

const router = Router();

/**
 * POST /admin/auth/login
 */
router.post("/admin/auth/login", adminLogin);

/**
 * GET /admin/stats
 * GET /admin/stats/providers
 */
router.get("/admin/stats", adminStats);
router.get("/admin/stats/providers", adminStatsProviders);

export default router;

