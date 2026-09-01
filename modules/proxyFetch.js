// proxyFetch: drop-in fetch wrapper that honors http_proxy / https_proxy /
// HTTP_PROXY / HTTPS_PROXY environment variables (Node's global fetch ignores
// them). Uses undici's ProxyAgent when a proxy is configured; falls back to the
// global fetch when no proxy is set or undici is unavailable.
//
// Local/loopback targets always bypass the proxy.
//
// Note: undici is loaded via createRequire — the bundled undici 5.x package
// has no ESM "exports" entry, so a bare `import("undici")` throws
// ERR_MODULE_NOT_FOUND and would silently disable proxying.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let undiciMod = null;
let undiciLoaded = false;
let dispatcher = null;
let dispatcherUrl = "";

function readProxyEnv() {
  return String(
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    ""
  ).trim();
}

function isLocalHost(url) {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

function ensureUndici() {
  if (undiciLoaded) return undiciMod;
  undiciLoaded = true;
  try {
    const mod = require("undici");
    if (mod && typeof mod.ProxyAgent === "function" && typeof mod.fetch === "function") {
      undiciMod = mod;
    }
  } catch {
    undiciMod = null;
  }
  return undiciMod;
}

function getDispatcher(proxyUrl) {
  const u = ensureUndici();
  if (!u) return null;
  if (!dispatcher || dispatcherUrl !== proxyUrl) {
    dispatcher = new u.ProxyAgent(proxyUrl);
    dispatcherUrl = proxyUrl;
  }
  return dispatcher;
}

/**
 * fetch(url, init) that routes through http(s)_proxy when configured.
 * Mirrors the standard fetch signature; the response comes from undici when
 * proxied (API-compatible for text()/json()/ok/status).
 */
export async function proxyFetch(url, init = {}) {
  const proxyUrl = readProxyEnv();
  if (!proxyUrl || isLocalHost(url)) {
    return fetch(url, init);
  }
  const u = ensureUndici();
  const dispatcher = getDispatcher(proxyUrl);
  if (!u || !dispatcher) {
    // No usable undici — keep legacy direct behavior.
    return fetch(url, init);
  }
  return u.fetch(url, { ...init, dispatcher });
}

export function proxyConfigured() {
  return !!readProxyEnv();
}
