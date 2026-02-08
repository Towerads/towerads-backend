import { Router } from "express";
import { requireTelegramUser } from "../middlewares/requireTelegramUser.js";

import { advertiserMe, me } from "../controllers/advertiser/advertiserController.js";
import { createCreative, listCreatives, submitCreative } from "../controllers/advertiser/creativesController.js";
import { createCampaign } from "../controllers/advertiser/campaignsController.js";

const router = Router();

router.get("/advertiser/me", requireTelegramUser, advertiserMe);
router.get("/me", requireTelegramUser, me);

router.post("/advertiser/creatives", requireTelegramUser, createCreative);
router.get("/advertiser/creatives", requireTelegramUser, listCreatives);
router.post("/advertiser/creatives/:id/submit", requireTelegramUser, submitCreative);

router.post("/advertiser/campaigns", requireTelegramUser, createCampaign);

// ✅ и так, и так
export default router;
export { router };

