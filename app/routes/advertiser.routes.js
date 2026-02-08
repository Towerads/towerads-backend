import { Router } from "express";
import { requireTelegramUser } from "../middlewares/requireTelegramUser.js";

import * as adv from "../controllers/advertiser/advertiserController.js";

import {
  createCreative,
  listCreatives,
  submitCreative,
} from "../controllers/advertiser/creativesController.js";

import { createCampaign } from "../controllers/advertiser/campaignsController.js";

console.log("ADV EXPORTS:", Object.keys(adv));

const advertiserMe = adv.advertiserMe;
const me = adv.me;

if (typeof advertiserMe !== "function" || typeof me !== "function") {
  console.error("❌ advertiserController exports are wrong:", Object.keys(adv));
  throw new Error("advertiserController.js must export named functions advertiserMe and me");
}

const router = Router();

router.get("/advertiser/me", requireTelegramUser, advertiserMe);
router.get("/me", requireTelegramUser, me);

router.post("/advertiser/creatives", requireTelegramUser, createCreative);
router.get("/advertiser/creatives", requireTelegramUser, listCreatives);
router.post("/advertiser/creatives/:id/submit", requireTelegramUser, submitCreative);

router.post("/advertiser/campaigns", requireTelegramUser, createCampaign);

export default router;
export { router };



