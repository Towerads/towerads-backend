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

// ✅ НОВОЕ: click-redirect (нужно для USL, чтобы трекать клики через редирект)
router.get("/api/tower-ads/click-redirect", tower.clickRedirect);

router.get("/api/tower-ads/stats", tower.stats);

/**
 * =========================
 *  PUBLISHER API (TMA)
 * =========================
 */
router.use("/api/publisher", publisherRoutes);

export default router;
export { router };


