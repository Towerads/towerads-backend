import { Router } from "express";

import requireTelegramUser from "../middlewares/requireTelegramUser.js";
import requirePublisher from "../middlewares/requirePublisher.js";

import {
  getSummary,
  getDaily,
} from "../controllers/publisher/publisherController.js";

const router = Router();

router.get(
  "/summary",
  requireTelegramUser,
  requirePublisher,
  getSummary
);

router.get(
  "/daily",
  requireTelegramUser,
  requirePublisher,
  getDaily
);

export default router;
