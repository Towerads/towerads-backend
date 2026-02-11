// towerads-backend/app/routes/publisher.routes.js
import { Router } from "express";
import {
  publisherSummary,
  publisherDaily,
  listPlacements,
  createPlacement,
  submitPlacement,
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
 * SUMMARY / DAILY / PROVIDERS
 */
router.get("/summary", publisherSummary);
router.get("/daily", publisherDaily);
router.get("/providers/stats", publisherProvidersStats);

/**
 * PLACEMENTS
 * ✅ GET  /publisher/placements
 * ✅ POST /publisher/placements          (create draft)
 * ✅ POST /publisher/placements/:id/submit (send to moderation)
 */
router.get("/placements", listPlacements);
router.post("/placements", createPlacement);
router.post("/placements/:id/submit", submitPlacement);

/**
 * SDK SCRIPT (ONLY APPROVED)
 * ✅ GET /publisher/sdk-script?placement_id=...
 * placement_id optional: if not provided -> last approved
 */
router.get("/sdk-script", getSdkScript);

export default router;
export { router };




