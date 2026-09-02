// Shared helpers for driving the embedded chrome-driverless browser via its
// MCP endpoint. Used by the QQ Music direct-download path (the web player's
// vkey CGI is only reachable with the browser's live cookies).
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

export async function cdEvaluate(expression, timeoutMs = 45000) {
  const result = await cdCall("pw/evaluate", { expression }, timeoutMs);
  return result?.value;
}

// Ensures the active browser page is on the given origin (same-origin fetches).
export async function cdEnsureOrigin(originPattern, url, timeoutMs = 45000) {
  try {
    const current = String(await cdEvaluate("location.href", 20000) || "");
    if (originPattern.test(current)) return;
  } catch { /* fall through to navigate */ }
  await cdCall("pw/navigate", { url }, timeoutMs);
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
