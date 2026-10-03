import fs from "node:fs";
import express from "express";
import { Prisma } from "@prisma/client";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { config } from "./config/index.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import apiRoutes from "./routes/index.js";

export function createApp() {
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
    if (!fs.existsSync(config.uploadDir)) fs.mkdirSync(config.uploadDir, { recursive: true });

    app.use(helmet());
    app.use(
        cors({
            origin: config.corsOrigin.split(","),
            credentials: true
        })
    );
    app.use(express.json({ limit: "10mb" }));
    app.use(express.urlencoded({ extended: true }));
    app.use(cookieParser());

    // CSRF guard for cookie-authenticated mutations: Bearer-header requests carry
    // an explicit custom header (not auto-sent cross-site); cookie-only requests
    // must prove same-origin via Origin/Referer. Non-browser clients without
    // Origin/Referer pass through.
    app.use("/api", (req, res, next) => {
        if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
            next();
            return;
        }
        if (req.headers.authorization || !req.cookies?.["pharmasuite_access"]) {
            next();
            return;
        }
        const origin = req.headers.origin;
        const referer = req.headers.referer;
        if (!origin && !referer) {
            next();
            return;
        }
        const allowed = config.corsOrigin
            .split(",")
            .map(o => o.trim().replace(/\/$/, ""))
            .filter(Boolean);
        const matches = (value: string): boolean => {
            try {
                const url = new URL(value);
                const normalized = `${url.protocol}//${url.host}`;
                return allowed.includes(normalized) || allowed.includes(value.replace(/\/$/, ""));
            } catch {
                return false;
            }
        };
        if ((origin && matches(origin)) || (!origin && referer && matches(referer))) {
            next();
            return;
        }
        res.status(403).json({ success: false, data: null, message: "Cross-origin request rejected.", code: "FORBIDDEN" });
    });

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
            handler: (_req, res) => {
                res.status(429).json({
                    success: false,
                    data: null,
                    message: "Too many requests. Please try again later.",
                    code: "TOO_MANY_REQUESTS"
                });
            }
        })
    );

    app.use("/api", apiRoutes);

    // Friendly root so opening the API origin in a browser (http://localhost:5000)
    // doesn't look like a "page not found" — the UI lives on the Next.js port.
    app.get("/", (_req, res) => {
        res.json({
            success: true,
            data: {
                name: "PharmaSuite API",
                status: "ok",
                docs: "/api/health",
                ui: config.corsOrigin.split(",")[0]
            },
            message: null
        });
    });

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}
