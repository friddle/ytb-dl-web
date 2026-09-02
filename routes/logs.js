import express from "express";
import { rateLimit } from "../modules/rateLimit.js";
import { getLogLines } from "../modules/logBuffer.js";

const router = express.Router();

// Serves the in-memory server log ring buffer for the LOG tab.
router.get("/api/logs", rateLimit(120, 60_000), (req, res) => {
  const limit = Math.max(20, Math.min(1000, Number(req.query.limit) || 400));
  const since = Number(req.query.since) || 0;
  res.json({ ok: true, lines: getLogLines({ limit, since }) });
});

export default router;