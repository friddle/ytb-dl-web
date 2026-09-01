import express from "express";
import { rateLimit } from "../modules/rateLimit.js";
import {
  getConfig,
  checkHealth,
  authFileLocations,
  exportCookiesTxt,
  loginStatus
} from "../modules/chromeDriverless.js";

const router = express.Router();

// Custom Gharmonize rateLimit middleware is applied on this route.
router.get("/api/chromebrowser", rateLimit(60, 60_000), async (_req, res) => {
  try {
    const [health, status] = await Promise.all([checkHealth(), Promise.resolve(loginStatus())]);
    res.json({
      config: {
        ...getConfig(),
        externalUrl: String(process.env.CHROME_DRIVERLESS_EXTERNAL_URL || "").trim() || null
      },
      health,
      authProfiles: authFileLocations(),
      login: status
    });
  } catch (err) {
    res.status(500).json({ error: { code: "CHROME_BROWSER_STATUS_FAILED", message: err?.message || "Failed" } });
  }
});

// Custom Gharmonize rateLimit middleware is applied on this route.
router.post("/api/chromebrowser/export-cookies", rateLimit(30, 60_000), (_req, res) => {
  try {
    const result = exportCookiesTxt();
    res.json({ ok: result.exported, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: { code: "COOKIE_EXPORT_FAILED", message: err?.message || "Failed" } });
  }
});

export default router;