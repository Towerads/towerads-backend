import { Router } from "express";

import {
  requestAd,
  providerResultBatch,
  impression,
  complete,
  click,
  stats,
} from "../controllers/api/towerAdsController.js";

const router = Router();

// HEALTH CHECK
router.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true });
});

// TOWER ADS API
router.post("/api/tower-ads/request", requestAd);
router.post("/api/tower-ads/provider-result-batch", providerResultBatch);
router.post("/api/tower-ads/impression", impression);
router.post("/api/tower-ads/complete", complete);
router.post("/api/tower-ads/click", click);
router.get("/api/tower-ads/stats", stats);

export default router;
export { router };

