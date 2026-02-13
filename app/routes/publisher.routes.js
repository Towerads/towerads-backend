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

router.use(requireTelegramUser);
router.use(requirePublisher);

router.get("/summary", publisherSummary);
router.get("/daily", publisherDaily);

// ✅ dashboard stats per active placements + totals by period
router.get("/dashboard", publisherDashboard);

router.get("/placements", listPlacements);
router.post("/placements", createPlacement);
router.post("/placements/:id/submit", submitPlacement);

router.get("/providers/stats", publisherProvidersStats);
router.get("/sdk-script", getSdkScript);

export default router;
export { router };


