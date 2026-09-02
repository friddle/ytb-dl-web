// Shared helpers for driving the embedded chrome-driverless browser via its
// MCP endpoint. All task operations run in their OWN tab (opened + tagged +
// closed), never touching the user's active tab, and are serialized through a
// single queue so concurrent tasks can't race each other.
import path from "path";

const CD_URL = () => String(process.env.CHROME_DRIVERLESS_URL || "").trim().replace(/\/+$/, "");

export async function cdCall(method, params = {}, timeoutMs = 45000) {
  const base = CD_URL();
  if (!base) throw new Error("CHROME_DRIVERLESS_URL not configured");
  const resp = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await resp.json().catch(() => ({}));
  if (data?.error) throw new Error(data.error.message || "chrome-driverless call failed");
  return data?.result;
}

export async function cdEvaluate(expression, timeoutMs = 45000, index = null) {
  const params = { expression };
  if (index !== null && Number.isInteger(index)) params.index = index;
  const result = await cdCall("pw/evaluate", params, timeoutMs);
  return result?.value;
}

// Global serialization: every browser task tab runs one at a time.
let browserOpQueue = Promise.resolve();

// Runs `fn(index)` inside a dedicated task tab for `url` (opened, tagged and
// always closed again — the user's own tabs are never touched).
export function withTaskTab(url, tag, fn, { timeoutMs = 60000 } = {}) {
  const run = async () => {
    let index = null;
    try {
      const opened = await cdCall("pw/new_tab", { url }, timeoutMs);
      index = opened?.index ?? null;
      if (index === null) throw new Error("could not open task tab");
      try { await cdCall("pw/tab_tag", { index, tag }, 10000); } catch { /* tag optional */ }
      return await fn(index);
    } finally {
      if (index !== null) {
        try { await cdCall("pw/tab_close", { index }, 15000); } catch { /* best effort */ }
      }
    }
  };
  const job = browserOpQueue.then(run, run);
  browserOpQueue = job.catch(() => {});
  return job;
}

// Downloads a (possibly IP/cookie-bound) direct media URL with progress.
export async function cdDownloadUrl(
  mediaUrl,
  targetPath,
  { headers = {}, timeoutMs = 10 * 60_000, progressCallback = null, isCanceled = null } = {}
) {
  const fs = await import("fs");
  const resp = await fetch(mediaUrl, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok || !resp.body) throw new Error(`direct download HTTP ${resp.status}`);
  const total = Number(resp.headers.get("content-length")) || 0;
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const out = fs.createWriteStream(targetPath);
  let done = 0;
  await new Promise((resolve, reject) => {
    resp.body.pipe(out);
    resp.body.on("data", (chunk) => {
      done += chunk.length;
      if (typeof progressCallback === "function" && total) {
        progressCallback(Math.min(99, Math.floor((done / total) * 100)));
      }
      if (isCanceled && isCanceled()) {
        resp.body.destroy();
        out.destroy();
        reject(new Error("canceled"));
      }
    });
    out.on("finish", resolve);
    out.on("error", reject);
    resp.body.on("error", reject);
  });
  return { filePath: targetPath, bytes: done, total };
}
