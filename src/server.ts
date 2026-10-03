import { config } from "./config/index.js";
import { createApp } from "./app.js";

const app = createApp();

/**
 * Keep-alive cron for Render free tier.
 * Pings /api/health every 14 minutes from 7 AM to 10 PM (local timezone).
 * Prevents Render free tier from spinning down during business hours.
 */
function startKeepAliveCron() {
  const INTERVAL_MS = 14 * 60 * 1000; // 14 minutes
  const START_HOUR = 7;  // 7 AM
  const END_HOUR = 22;   // 10 PM

  function isBusinessHours(): boolean {
    const now = new Date();
    const hour = now.getHours();
    return hour >= START_HOUR && hour < END_HOUR;
  }

  function pingHealth() {
    if (!isBusinessHours()) return;

    const url = `http://localhost:${config.port}/api/health`;
    fetch(url)
      .then((res) => {
        if (res.ok) {
          console.log(`[keep-alive] ${new Date().toISOString()} - Health check OK`);
        } else {
          console.warn(`[keep-alive] ${new Date().toISOString()} - Health check failed: ${res.status}`);
        }
      })
      .catch((err) => {
        console.error(`[keep-alive] ${new Date().toISOString()} - Health check error:`, err.message);
      });
  }

  // Initial ping
  pingHealth();

  // Schedule recurring pings
  setInterval(pingHealth, INTERVAL_MS);


}

const server = app.listen(config.port, () => {
  console.log(`🚀 PharmaSuite API listening on http://localhost:${config.port}`);
  startKeepAliveCron();
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[server] SIGTERM received, shutting down gracefully");
  server.close(() => {
    console.log("[server] Closed");
    process.exit(0);
  });
});
