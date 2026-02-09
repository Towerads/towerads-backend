import express from "express";
import cookieParser from "cookie-parser";
import path from "path";

import "./config/env.js";     // dotenv + MIN_MARGIN_CPM log
import "./config/db.js";      // подключение БД при старте

import { requestLogger } from "./middlewares/requestLogger.js";
import { corsMiddleware } from "./middlewares/cors.js";

import adminRoutes from "./routes/admin.routes.js";
import advertiserRoutes from "./routes/advertiser.routes.js";
import apiRoutes from "./routes/api.routes.js";
import publisherRoutes from "./routes/publisher.routes.js";

const app = express();

app.use(express.json());
app.use(requestLogger);
app.use(cookieParser());

app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
app.use(corsMiddleware);

// routes
app.use(adminRoutes);
app.use(advertiserRoutes);
app.use(apiRoutes);
app.use("/publisher", publisherRoutes);

export default app;


