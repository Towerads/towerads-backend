import { Router } from "express";
import {
  publisherSummary,
  publisherDaily,
  listPlacements,
  publisherProvidersStats,
  getSdkScript,
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
 * GET /publisher/summary
 * GET /publisher/daily
 * GET /publisher/placements
 * GET /publisher/sdk-script
 */
router.get("/summary", publisherSummary);
router.get("/daily", publisherDaily);
router.get("/placements", listPlacements);
router.get("/providers/stats", publisherProvidersStats);
router.get("/sdk-script", getSdkScript);

export default router;
export { router };



