import express from "express";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { spawnSafe } from "../modules/safeProcess.js";
import { rateLimit } from "../modules/rateLimit.js";
import { loginStatus, isPlatformLoggedIn } from "../modules/chromeDriverless.js";
import { YTDLP_BIN, getBinaryRuntimeEnv } from "../modules/binaries.js";
import { getExtraArgs } from "../modules/config.js";

const router = express.Router();

const BASE_DIR = process.env.DATA_DIR || process.cwd();
const COOKIES_FILE =
  String(process.env.YTDLP_COOKIES || "").trim() ||
  path.join(BASE_DIR, "cookies", "cookies.txt");

const CD_URL = String(process.env.CHROME_DRIVERLESS_URL || "").trim().replace(/\/+$/, "");
const BROWSER_EXTERNAL_URL = String(process.env.CHROME_DRIVERLESS_EXTERNAL_URL || "").trim();

// User-configurable download folder (saved via Settings → MEDIA_DOWNLOAD_DIR).
// Falls back to the default <data>/outputs directory.
const MEDIA_DOWNLOAD_DIR = String(process.env.MEDIA_DOWNLOAD_DIR || "").trim()
  ? path.resolve(process.env.MEDIA_DOWNLOAD_DIR)
  : path.join(BASE_DIR, "outputs");

// Deep-link targets: clicking a platform login button opens this page inside
// the embedded browser. For the China platforms these are the QR-code login
// pages (Bilibili/NetEase/QQ), YouTube goes straight to the sign-in page.
const PLATFORM_LOGIN_URLS = {
  bilibili: "https://passport.bilibili.com/login",
  bililive: "https://passport.bilibili.com/login",
  netease: "https://music.163.com/#/login",
  neteaselive: "https://music.163.com/#/login",
  qqmusic:
    "https://graph.qq.com/oauth2.0/show?which=Login&display=pc&client_id=100460100&response_type=code&redirect_uri=https%3A%2F%2Fy.qq.com%2Fportal%2Fplayer.html",
  youtube: "https://www.youtube.com/signin"
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Runs curl (which honors the container proxy env) and parses JSON output.
function curlJson(url, { headers = {}, method = "GET", data = null, timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-s", "--compressed", "-m", String(Math.ceil(timeoutMs / 1000)), "-X", method, url];
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    if (data) args.push("--data", data);
    execFile(
      "curl",
      args,
      { timeout: timeoutMs + 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(new Error(`upstream request failed: ${err.message}`));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`upstream returned non-JSON: ${String(stdout).slice(0, 120)}`));
        }
      }
    );
  });
}

// Calls the embedded chrome-driverless MCP endpoint (same container, no proxy needed).
async function cdCall(method, params = {}, timeoutMs = 45000) {
  if (!CD_URL) throw new Error("CHROME_DRIVERLESS_URL not configured");
  const resp = await fetch(`${CD_URL}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await resp.json().catch(() => ({}));
  if (data?.error) throw new Error(data.error.message || "chrome-driverless call failed");
  return data?.result;
}

async function cdEvaluate(expression, timeoutMs = 45000) {
  const result = await cdCall("pw/evaluate", { expression }, timeoutMs);
  return result?.value;
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function parseDurationToSec(d) {
  // Bilibili returns "mm:ss" or "hh:mm:ss".
  const parts = String(d || "").split(":").map((p) => Number(p) || 0);
  if (!parts.length) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0) || null;
}

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 20;
  return Math.max(1, Math.min(50, Math.round(n)));
}

// ---------------------------------------------------------------------------
// Search adapters → unified item: { id, platform, title, artist, album, durationSec, url }
// ---------------------------------------------------------------------------

async function searchQqMusic(keyword, limit) {
  const url = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&n=${limit}&w=${encodeURIComponent(keyword)}`;
  const data = await curlJson(url, {
    headers: { "User-Agent": UA, Referer: "https://y.qq.com/" }
  });
  const list = data?.data?.song?.list || [];
  return list.map((s) => {
    const singers = (s.singer || []).map((x) => x.name).join(" / ");
    const songmid = s.songmid || s.mid || "";
    return {
      id: songmid,
      platform: "qqmusic",
      title: stripHtml(s.songname || s.name || ""),
      artist: singers,
      album: stripHtml(s.albumname || ""),
      durationSec: Number(s.interval) || null,
      url: `https://y.qq.com/n/ryqq/songDetail/${songmid}`
    };
  }).filter((it) => it.id && it.title);
}

async function searchNetease(keyword, limit) {
  const data = await curlJson("https://music.163.com/api/search/get", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Referer: "https://music.163.com/",
      Cookie: "os=pc"
    },
    data: `s=${encodeURIComponent(keyword)}&type=1&offset=0&total=true&limit=${limit}`
  });
  const songs = data?.result?.songs || [];
  return songs.map((s) => ({
    id: String(s.id),
    platform: "netease",
    title: stripHtml(s.name || s.title || ""),
    artist: (s.artists || []).map((a) => a.name).join(" / "),
    album: stripHtml(s.album?.name || s.albumname || ""),
    durationSec: Math.round((Number(s.duration) || 0) / 1000) || null,
    url: `https://music.163.com/#/song?id=${s.id}`
  })).filter((it) => it.id && it.title);
}

async function searchBililive(keyword, limit) {
  // Bilibili live room search (search_type=live_room), also needs login cookies.
  const currentUrl = String(await cdEvaluate("location.href", 20000) || "");
  if (!/bilibili\.com/.test(currentUrl)) {
    await cdCall("pw/navigate", { url: "https://www.bilibili.com/" }, 45000);
  }
  const expression = `(async () => {
    const r = await fetch("https://api.bilibili.com/x/web-interface/search/type?search_type=live_room&keyword=${encodeURIComponent(
      keyword
    )}&page=1", { credentials: "include", headers: { "Accept": "application/json" } });
    const j = await r.json();
    return j;
  })()`;
  const data = await cdEvaluate(expression, 45000);
  if (!data || data.code !== 0 || !Array.isArray(data?.data?.result)) {
    const msg = data?.message || `bilibili live search code ${data?.code ?? "?"}`;
    throw new Error(`Bilibili 直播搜索失败: ${msg}`);
  }
  return data.data.result.slice(0, limit).map((v) => {
    const roomId = v.roomid || v.id;
    return {
      id: String(roomId || ""),
      platform: "bililive",
      title: stripHtml(v.title || ""),
      artist: stripHtml(v.uname || v.upName || ""),
      album: "",
      durationSec: null,
      url: roomId ? `https://live.bilibili.com/${roomId}` : ""
    };
  }).filter((it) => it.id && it.title && it.url);
}

async function searchNeteaseLive(keyword, limit) {
  // NetEase Cloud Music 主播电台 / 直播 (DJ radio) — public search API, type=1009.
  const data = await curlJson("https://music.163.com/api/search/get", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Referer: "https://music.163.com/",
      Cookie: "os=pc"
    },
    data: `s=${encodeURIComponent(keyword)}&type=1009&offset=0&total=true&limit=${limit}`
  });
  const radios = data?.result?.djRadios || [];
  return radios.map((d) => ({
    id: String(d.id || ""),
    platform: "neteaselive",
    title: stripHtml(d.name || ""),
    artist: stripHtml(d.dj?.nickname || ""),
    album: d.category ? stripHtml(d.category) : "",
    durationSec: null,
    url: d.id ? `https://music.163.com/#/djradio?id=${d.id}` : ""
  })).filter((it) => it.id && it.title && it.url);
}

async function searchYoutube(keyword, limit) {
  // YouTube search via yt-dlp (ytsearchN:<query>); works with the saved cookies.
  const data = await ytdlpFlatJson(`ytsearch${Math.min(limit, 30)}:${keyword}`);
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  return entries.map((e) => ({
    id: String(e.id || ""),
    platform: "youtube",
    title: stripHtml(e.title || ""),
    artist: stripHtml(e.uploader || e.channel || ""),
    album: "",
    durationSec: Number(e.duration) || null,
    url: e.id ? `https://www.youtube.com/watch?v=${e.id}` : ""
  })).filter((it) => it.id && it.title && it.url);
}

async function searchBilibili(keyword, limit) {
  // api.bilibili.com blocks non-browser clients (risk-control HTML page), so
  // the query runs inside the embedded browser context with its real Chrome
  // fingerprint and login cookies.
  const currentUrl = String(await cdEvaluate("location.href", 20000) || "");
  if (!/bilibili\.com/.test(currentUrl)) {
    await cdCall("pw/navigate", { url: "https://www.bilibili.com/" }, 45000);
  }
  const expression = `(async () => {
    const r = await fetch("https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(
      keyword
    )}&page=1", { credentials: "include", headers: { "Accept": "application/json" } });
    const j = await r.json();
    return j;
  })()`;
  const data = await cdEvaluate(expression, 45000);
  if (!data || data.code !== 0 || !Array.isArray(data?.data?.result)) {
    const msg = data?.message || `bilibili search code ${data?.code ?? "?"}`;
    throw new Error(`Bilibili 搜索失败: ${msg}`);
  }
  return data.data.result.slice(0, limit).map((v) => ({
    id: v.bvid,
    platform: "bilibili",
    title: stripHtml(v.title),
    artist: stripHtml(v.author || ""),
    album: "",
    durationSec: parseDurationToSec(v.duration),
    url: `https://www.bilibili.com/video/${v.bvid}/`
  })).filter((it) => it.id && it.title);
}

// ---------------------------------------------------------------------------
// Bilibili URL resolve (single video vs. multi-part collection) via yt-dlp
// ---------------------------------------------------------------------------

function ytdlpFlatJson(url) {
  return new Promise((resolve, reject) => {
    const args = ["--ignore-config", "--no-warnings", "--socket-timeout", "15", "--force-ipv4", "-J", "--flat-playlist"];
    for (const extra of getExtraArgs()) args.push(extra);
    if (fs.existsSync(COOKIES_FILE)) args.push("--cookies", COOKIES_FILE);
    args.push(url);
    const child = spawnSafe(YTDLP_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: getBinaryRuntimeEnv()
    });
    let out = "";
    let errOut = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("resolve timeout"));
    }, 60000);
    child.stdout.on("data", (c) => { out += c.toString(); });
    child.stderr.on("data", (c) => { errOut += c.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`resolve JSON error: ${e.message}`)); }
      } else {
        reject(new Error(`yt-dlp exit ${code}: ${errOut.split("\n").slice(-5).join(" ").slice(0, 300)}`));
      }
    });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get("/api/media/config", rateLimit(60, 60_000), (_req, res) => {
  res.json({
    ok: true,
    platforms: loginStatus().platforms,
    loginUrls: PLATFORM_LOGIN_URLS,
    browserExternalUrl: BROWSER_EXTERNAL_URL || null,
    downloadDir: MEDIA_DOWNLOAD_DIR
  });
});

router.get("/api/media/search", rateLimit(30, 60_000), async (req, res) => {
  const platform = String(req.query.platform || "").toLowerCase();
  const keyword = String(req.query.keyword || "").trim();
  const limit = clampLimit(req.query.limit);
  if (!keyword) return res.status(400).json({ error: { code: "KEYWORD_REQUIRED", message: "keyword is required" } });

  try {
    let items = [];
    const loginGate = (label) => {
      if (isPlatformLoggedIn("bilibili")) return true;
      return res.status(428).json({
        error: {
          code: "PLATFORM_LOGIN_REQUIRED",
          message: `${label}搜索需要先登录：请点击右上角 🛩️ 打开内置浏览器扫码登录后重试。`
        }
      });
    };
    if (platform === "qqmusic") {
      // QQ Music search works without login (public search API).
      items = await searchQqMusic(keyword, limit);
    } else if (platform === "netease") {
      items = await searchNetease(keyword, limit);
    } else if (platform === "neteaselive") {
      items = await searchNeteaseLive(keyword, limit);
    } else if (platform === "youtube") {
      items = await searchYoutube(keyword, limit);
    } else if (platform === "bilibili") {
      if (!loginGate("Bilibili（哔哩哔哩）")) return;
      items = await searchBilibili(keyword, limit);
    } else if (platform === "bililive") {
      if (!loginGate("Bilibili 直播")) return;
      items = await searchBililive(keyword, limit);
    } else {
      return res.status(400).json({ error: { code: "UNKNOWN_PLATFORM", message: "platform must be qqmusic | netease | neteaselive | bilibili | bililive | youtube" } });
    }
    res.json({ ok: true, platform, keyword, count: items.length, items });
  } catch (err) {
    console.warn(`[media] search ${platform} failed:`, err?.message || err);
    res.status(502).json({ error: { code: "SEARCH_FAILED", message: err?.message || "search failed" } });
  }
});

router.get("/api/media/resolve", rateLimit(20, 60_000), async (req, res) => {
  let url = String(req.query.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: { code: "URL_REQUIRED", message: "url is required" } });
  }
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* fallthrough */ }
  // NetEase Music SPA links (music.163.com/#/playlist?id=x) — the hash part is
  // never sent server-side; normalize to the plain path yt-dlp understands.
  const isNetease = host.includes("163.com");
  if (isNetease) {
    // "music.163.com/#/playlist|album|song|djradio?id=x" → plain path.
    url = url.replace(/#\/(playlist|album|song|djradio|radio)\?/i, "$1?");
  }

  try {
    const data = await ytdlpFlatJson(url);
    const entries = Array.isArray(data?.entries) ? data.entries : null;
    if (entries) {
      const playlistTitle = stripHtml(data.title || "");
      const items = entries.map((e, i) => {
        const pagePart = e.playlist_index || (i + 1);
        if (isNetease) {
          // NetEase playlist entries are individual songs.
          return {
            id: e.id || String(i + 1),
            index: pagePart,
            title: stripHtml(e.title || `Track ${pagePart}`),
            artist: stripHtml(e.uploader || e.artist || ""),
            durationSec: Number(e.duration) || null,
            url: e.id ? `https://music.163.com/song?id=${e.id}` : url
          };
        }
        // yt-dlp flat-playlist entries for Bilibili collections often carry an
        // empty title; fall back to "<playlist title> P<n>".
        const rawTitle = stripHtml(e.title || "");
        const title = rawTitle && !/^p\d+$/i.test(rawTitle)
          ? rawTitle
          : `${playlistTitle ? playlistTitle + " " : ""}P${pagePart}`;
        return {
          id: e.id || String(i + 1),
          index: pagePart,
          title,
          artist: stripHtml(e.uploader || ""),
          durationSec: Number(e.duration) || null,
          url: `https://www.bilibili.com/video/${data.id}/?p=${pagePart}`
        };
      }).filter((it) => it.title);
      return res.json({ ok: true, mode: "list", title: stripHtml(data.title || ""), totalCount: items.length, items });
    }
    const single = {
      id: data?.id || "",
      index: 1,
      title: stripHtml(data?.title || ""),
      artist: stripHtml(data?.uploader || ""),
      durationSec: Number(data?.duration) || null,
      url: data?.webpage_url || url
    };
    return res.json({ ok: true, mode: "single", title: single.title, totalCount: 1, items: [single] });
  } catch (err) {
    console.warn("[media] resolve failed:", err?.message || err);
    res.status(502).json({ error: { code: "RESOLVE_FAILED", message: err?.message || "resolve failed" } });
  }
});

export default router;
