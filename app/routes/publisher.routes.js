import { Router } from "express";
import {
  publisherSummary,
  publisherDaily,
  listPlacements,
  createPlacement,
  submitPlacement,
  publisherProvidersStats,
  getSdkScript,
  publisherDashboard,
} from "../controllers/publisher/publisherController.js";

import { requireTelegramUser } from "../middlewares/requireTelegramUser.js";
import requirePublisher from "../middlewares/requirePublisher.js";

const router = Router();

/**
 * Telegram Mini App auth chain:
 * 1) requireTelegramUser -> req.tgUserId
 * 2) requirePublisher    -> req.publisher { publisherId, role }
 */
router.use(requireTelegramUser);
router.use(requirePublisher);

/**
 * GET  /publisher/summary
 * GET  /publisher/daily
 * GET  /publisher/dashboard   ✅ new
 * GET  /publisher/placements
 * POST /publisher/placements
 * POST /publisher/placements/:id/submit
 * GET  /publisher/providers/stats
 * GET  /publisher/sdk-script
 */
router.get("/summary", publisherSummary);
router.get("/daily", publisherDaily);
router.get("/dashboard", publisherDashboard);

router.get("/placements", listPlacements);
router.post("/placements", createPlacement);
router.post("/placements/:id/submit", submitPlacement);

router.get("/providers/stats", publisherProvidersStats);
router.get("/sdk-script", getSdkScript);

export default router;
export { router };

