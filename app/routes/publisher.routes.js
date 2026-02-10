import { Router } from "express";
import {
  publisherSummary,
  publisherDaily,
} from "../controllers/publisher/publisherController.js";

const router = Router();

/**
 * GET /publisher/summary
 * GET /publisher/daily
 */
router.get("/summary", publisherSummary);
router.get("/daily", publisherDaily);

export default router;
export { router };
