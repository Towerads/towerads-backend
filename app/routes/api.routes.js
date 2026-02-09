import { Router } from "express";

import * as tower from "../controllers/api/towerAdsController.js";

// ⬇️ НОВОЕ: publisher routes
import publisherRoutes from "./publisher.routes.js";

console.log("TOWER EXPORTS:", Object.keys(tower));

const requestAd = tower.requestAd;
const providerResultBatch = tower.providerResultBatch;
const impression = tower.impression;
const complete = tower.complete;
const click = tower.click;
const stats = tower.stats;

const mustBeFn = (name, fn) => {
  if (typeof fn !== "function") {
    throw new Error(`towerAdsController.js missing export: ${name}`);
  }
};

mustBeFn("requestAd", requestAd);
mustBeFn("providerResultBatch", providerResultBatch);
mustBeFn("impression", impression);
mustBeFn("complete", complete);
mustBeFn("click", click);
mustBeFn("stats", stats);

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
router.post("/api/tower-ads/request", requestAd);
router.post("/api/tower-ads/provider-result-batch", providerResultBatch);
router.post("/api/tower-ads/impression", impression);
router.post("/api/tower-ads/complete", complete);
router.post("/api/tower-ads/click", click);
router.get("/api/tower-ads/stats", stats);

/**
 * =========================
 *  PUBLISHER API (TMA)
 * =========================
 * Все роуты:
 *   GET /api/publisher/summary
 *   GET /api/publisher/daily
 */
router.use("/api/publisher", publisherRoutes);

export default router;
export { router };


