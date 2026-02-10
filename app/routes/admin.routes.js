import { Router } from "express";
import {
  adminStats,
  adminStatsProviders,
} from "../controllers/admin/statsController.js";

const router = Router();

/**
 * GET /admin/stats
 * GET /admin/stats/providers
 */
router.get("/admin/stats", adminStats);
router.get("/admin/stats/providers", adminStatsProviders);

export default router;
export { router };

