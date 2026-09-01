import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const CD_URL = String(process.env.CHROME_DRIVERLESS_URL || "").trim();
const CD_DATA_DIR = String(
  process.env.CHROME_DRIVERLESS_DATA_DIR ||
  process.env.BROWSER_DATA_DIR ||
  ""
).trim();
const CD_PROFILE = String(
  process.env.CHROME_DRIVERLESS_PROFILE ||
  process.env.PROFILE_NAME ||
  "debug"
)
  .trim() || "debug";
const COOKIES_DIR = path.resolve(process.env.DATA_DIR || process.cwd(), "cookies");
const EXPORT_COOKIES_FILE =
  String(process.env.YTDLP_COOKIES || "").trim() ||
  path.join(COOKIES_DIR, "cookies.txt");

// Platforms whose login cookies we harvest from the embedded browser profile.
const PLATFORM_DOMAINS = {
  bilibili: [".bilibili.com", "bilibili.com", ".b23.tv", "b23.tv"],
  netease: [".music.163.com", "music.163.com", ".163.com", "163.com"],
  qqmusic: [".y.qq.com", "y.qq.com", ".qq.com", "qq.com", "i.qq.com"]
};

function baseUrl() {
  return CD_URL ? CD_URL.replace(/\/+$/, "") : "";
}

export function isConfigured() {
  return !!CD_URL;
}

export function getConfig() {
  return {
    enabled: isConfigured(),
    url: baseUrl() || null,
    dataDir: CD_DATA_DIR || null,
    profile: CD_PROFILE,
    exportedCookiesFile: EXPORT_COOKIES_FILE,
    healthUrl: baseUrl() ? `${baseUrl()}/health` : null
  };
}

// Performs a live health check against the embedded browser service.
export async function checkHealth() {
  if (!isConfigured()) {
    return { ok: false, enabled: false, configured: false, error: "CHROME_DRIVERLESS_URL not set" };
  }
  try {
    const resp = await fetch(`${baseUrl()}/health`, {
      signal: AbortSignal.timeout(8000)
    });
    const body = await resp.text().catch(() => "");
    return {
      ok: resp.ok,
      enabled: true,
      configured: true,
      status: resp.status,
      body: body.slice(0, 400)
    };
  } catch (e) {
    return {
      ok: false,
      enabled: true,
      configured: true,
      error: e?.message || String(e)
    };
  }
}

// Lists auth.json files found inside the shared browser profile directory.
// Supports both layouts: <root>/<profile>/auth.json (legacy) and
// <root>/profiles/<profile>/auth.json (current chrome-driverless).
export function authFileLocations() {
  if (!CD_DATA_DIR) return [];
  const root = path.resolve(CD_DATA_DIR);
  const out = [];
  const seen = new Set();
  const scanDir = (dir, prefix = "") => {
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name === "tmp") continue;
        const authPath = path.join(dir, ent.name, "auth.json");
        if (fs.existsSync(authPath) && !seen.has(authPath)) {
          seen.add(authPath);
          out.push({ profile: prefix + ent.name, path: authPath });
        }
      }
    } catch {}
  };
  scanDir(root);
  scanDir(path.join(root, "profiles"), "profiles/");
  return out;
}

function readAuthJson(authPath) {
  try {
    return JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    return null;
  }
}

// Collects all cookies across saved browser profiles as flat cookie objects.
export function collectCookies() {
  const cookies = [];
  for (const loc of authFileLocations()) {
    const data = readAuthJson(loc.path);
    const items = Array.isArray(data?.cookies) ? data.cookies : [];
    for (const c of items) {
      if (c?.name && c?.value && c?.domain) cookies.push(c);
    }
  }
  return cookies;
}

// Converts an auth.json cookie object to a Netscape cookies.txt line pair.
function authToNetscapeLine(c) {
  let domain = String(c.domain || "").trim();
  const name = String(c.name || "").trim();
  const value = String(c.value || "").trim();
  if (!domain || !name || !value) return null;

  // Python http.cookiejar asserts domain_specified == domain.startsWith(".");
  // a hostOnly=false cookie stored without a leading dot needs one added.
  const includeSub = !c.hostOnly;
  if (includeSub && !domain.startsWith(".")) domain = `.${domain}`;
  const p = String(c.path || "/");
  const secure = c.secure ? "TRUE" : "FALSE";
  const exp = c.session || !c.expirationDate ? "0" : String(Math.round(Number(c.expirationDate) || 0));
  return [domain, includeSub ? "TRUE" : "FALSE", p, secure, exp, name, value].join("\t");
}

// Filters cookies by a platform domain whitelist.
function filterCookiesForDomain(cookies, domains) {
  const suffixList = domains.map((d) => d.toLowerCase().replace(/^\./, ""));
  const suffix = (d) => String(d.domain || "").toLowerCase().replace(/^\./, "");
  return cookies.filter((c) => suffixList.some((s) => {
    const dom = suffix(c);
    return dom === s || dom.endsWith("." + s) || s.endsWith("." + dom);
  }));
}

// Writes one Netscape cookies.txt per platform into the cookie export folder.
export function exportCookiesTxt() {
  const all = collectCookies();
  if (!all.length) return { exported: false, written: [], cookies: 0 };
  const written = [];
  let count = 0;

  const header = "# Netscape HTTP Cookie File\n# This file is generated from the embedded browser profile for yt-dlp.\n";

  for (const [platform, domains] of Object.entries(PLATFORM_DOMAINS)) {
    const filtered = filterCookiesForDomain(all, domains);
    if (!filtered.length) continue;
    const lines = filtered.map(authToNetscapeLine).filter(Boolean);
    if (!lines.length) continue;
    const target = path.join(COOKIES_DIR, `${platform}-cookies.txt`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, header + lines.join("\n") + "\n", "utf8");
    written.push(target);
    count += filtered.length;
  }

  // Write the combined file too (single YTDLP_COOKIES path).
  const combinedLines = all.map(authToNetscapeLine).filter(Boolean);
  if (combinedLines.length) {
    fs.mkdirSync(path.dirname(EXPORT_COOKIES_FILE), { recursive: true });
    fs.writeFileSync(EXPORT_COOKIES_FILE, header + combinedLines.join("\n") + "\n", "utf8");
    written.push(EXPORT_COOKIES_FILE);
  }

  return { exported: true, written, cookies: count };
}

// Determines which platforms have login cookies available right now.
// A real login requires the platform's session cookie (e.g. SESSDATA for
// Bilibili); anonymous visitor cookies (buvid3, ...) do NOT count.
const PLATFORM_LOGIN_COOKIES = {
  bilibili: ["SESSDATA"],
  netease: ["MUSIC_U"],
  qqmusic: ["qqmusic_key", "wxuin", "uin"]
};

export function loginStatus() {
  const all = collectCookies();
  const status = {};
  for (const [platform, domains] of Object.entries(PLATFORM_DOMAINS)) {
    const platformCookies = filterCookiesForDomain(all, domains);
    const required = PLATFORM_LOGIN_COOKIES[platform] || [];
    const hasSession = platformCookies.some((c) => required.includes(c.name));
    const file = path.join(COOKIES_DIR, `${platform}-cookies.txt`);
    status[platform] = {
      loggedIn: hasSession,
      hasCookies: platformCookies.length > 0,
      cookies: platformCookies.length,
      cookieFile: fs.existsSync(file) ? file : null
    };
  }
  return { platforms: status, totalCookies: all.length };
}

// Returns true only when the embedded browser profile holds a real login
// session for the given platform (bilibili / netease / qqmusic).
export function isPlatformLoggedIn(platform) {
  const key = String(platform || "").toLowerCase();
  const required = PLATFORM_LOGIN_COOKIES[key];
  if (!required) return true; // no login requirement for other platforms
  const domains = PLATFORM_DOMAINS[key];
  if (!domains) return true;
  const platformCookies = filterCookiesForDomain(collectCookies(), domains);
  return platformCookies.some((c) => required.includes(c.name));
}

export default { isConfigured, getConfig, checkHealth, authFileLocations, collectCookies, exportCookiesTxt, loginStatus, isPlatformLoggedIn };