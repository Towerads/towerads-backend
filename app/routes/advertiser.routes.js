import { Router } from "express";
import { requireTelegramUser } from "../middlewares/requireTelegramUser.js";

import * as adv from "../controllers/advertiser/advertiserController.js";
import * as creatives from "../controllers/advertiser/creativesController.js";
import * as campaigns from "../controllers/advertiser/campaignsController.js";

console.log("ADV EXPORTS:", Object.keys(adv));
console.log("CREATIVES EXPORTS:", Object.keys(creatives));
console.log("CAMPAIGNS EXPORTS:", Object.keys(campaigns));

const advertiserMe = adv.advertiserMe;
const me = adv.me;

const createCreative = creatives.createCreative;
const listCreatives = creatives.listCreatives;
const submitCreative = creatives.submitCreative;

const createCampaign = campaigns.createCampaign;

// Жёсткая проверка, чтобы сразу было понятно, чего не хватает
const mustBeFn = (name, fn, keys) => {
  if (typeof fn !== "function") {
    console.error(`❌ Missing export: ${name}. Available:`, keys);
    throw new Error(`Missing export: ${name}`);
  }
};

mustBeFn("advertiserMe", advertiserMe, Object.keys(adv));
mustBeFn("me", me, Object.keys(adv));
mustBeFn("createCreative", createCreative, Object.keys(creatives));
mustBeFn("listCreatives", listCreatives, Object.keys(creatives));
mustBeFn("submitCreative", submitCreative, Object.keys(creatives));
mustBeFn("createCampaign", createCampaign, Object.keys(campaigns));

const router = Router();

router.get("/advertiser/me", requireTelegramUser, advertiserMe);
router.get("/me", requireTelegramUser, me);

router.post("/advertiser/creatives", requireTelegramUser, createCreative);
router.get("/advertiser/creatives", requireTelegramUser, listCreatives);
router.post("/advertiser/creatives/:id/submit", requireTelegramUser, submitCreative);

router.post("/advertiser/campaigns", requireTelegramUser, createCampaign);

export default router;
export { router };




