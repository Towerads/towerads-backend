import { Router } from "express";

import { requireTelegramUser } from "../middlewares/requireTelegramUser.js";
import requirePublisher from "../middlewares/requirePublisher.js";

import {
  getSummary,
  getDaily,
  listPlacements,
  createPlacement,
  submitPlacement,
} from "../controllers/publisher/publisherController.js";

const router = Router();

/* =========================
   STATS
========================= */

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

/* =========================
   PLACEMENTS (доски)
========================= */

// список досок
router.get(
  "/placements",
  requireTelegramUser,
  requirePublisher,
  listPlacements
);

// создать доску
router.post(
  "/placements",
  requireTelegramUser,
  requirePublisher,
  createPlacement
);

// отправить на модерацию
router.post(
  "/placements/:id/submit",
  requireTelegramUser,
  requirePublisher,
  submitPlacement
);

export default router;

