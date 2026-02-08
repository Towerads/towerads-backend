import { Router } from "express";

import * as tower from "../controllers/api/towerAdsController.js";

console.log("TOWER EXPORTS:", Object.keys(tower));

const requestAd = tower.requestAd;
const providerResultBatch = tower.providerResultBatch;
const impression = tower.impression;
const complete = tower.complete;
const click = tower.click; // <- если нет, увидим в логах
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

router.get("/healthz", (req, res) => res.status(200).json({ ok: true }));

router.post("/api/tower-ads/request", requestAd);
router.post("/api/tower-ads/provider-result-batch", providerResultBatch);
router.post("/api/tower-ads/impression", impression);
router.post("/api/tower-ads/complete", complete);
router.post("/api/tower-ads/click", click);
router.get("/api/tower-ads/stats", stats);

export default router;
export { router };

