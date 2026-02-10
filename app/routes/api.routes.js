import { Router } from "express";

import * as tower from "../controllers/api/towerAdsController.js";
import publisherRoutes from "./publisher.routes.js";

const router = Router();

/**
 * Healthcheck
 */
router.get("/healthz", (req, res) => res.status(200).json({ ok: true }));

/**
 * =========================
 *  TOWER ADS (SDK / API)
 * =========================
 */
router.post("/api/tower-ads/request", tower.requestAd);
router.post("/api/tower-ads/provider-result-batch", tower.providerResultBatch);
router.post("/api/tower-ads/impression", tower.impression);
router.post("/api/tower-ads/complete", tower.complete);
router.post("/api/tower-ads/click", tower.click);
router.get("/api/tower-ads/stats", tower.stats);

/**
 * =========================
 *  PUBLISHER API (TMA)
 * =========================
 */
router.use("/api/publisher", publisherRoutes);

export default router;
export { router };


