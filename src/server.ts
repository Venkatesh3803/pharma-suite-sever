import fs from "node:fs";
import express from "express";
import { Prisma } from "@prisma/client";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { config } from "./config";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import apiRoutes from "./routes";

const app = express();

// Requests reach this server through a single reverse proxy (the Next.js dev
// proxy in development, a load balancer/nginx in production). Trusting that
// hop lets express-rate-limit use the real client IP from X-Forwarded-For
// instead of erroring out (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR).
app.set("trust proxy", 1);

/**
 * Convert Prisma Decimal (and nested Date/Decimal trees) into plain JSON
 * numbers so clients never receive stringified money values.
 */
function serializeJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Prisma.Decimal) return Number(value.toString());
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(v => serializeJson(v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = serializeJson(v);
  }
  return out;
}

if (!fs.existsSync("tmp")) fs.mkdirSync("tmp", { recursive: true });
if (!fs.existsSync(config.uploadDir))
  fs.mkdirSync(config.uploadDir, { recursive: true });

app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigin.split(","),
    credentials: true,
  }),
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Emit money fields as numbers instead of Prisma Decimal strings.
app.use((req, res, next) => {
  const send = res.json.bind(res);
  res.json = (body: unknown) => send(serializeJson(body));
  next();
});

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.use("/api", apiRoutes);

// Prescription file downloads are attached to the API router already; nothing
// static is exposed here to keep patient files private.

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`🚀 PharmaSuite API listening on http://localhost:${config.port}`);
});