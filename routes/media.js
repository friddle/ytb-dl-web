import express from "express";
import { execFile } from "child_process";
import { Readable } from "node:stream";
import fs from "fs";
import path from "path";
import { spawnSafe } from "../modules/safeProcess.js";
import { rateLimit } from "../modules/rateLimit.js";
import { requireAuth } from "../modules/settings.js";
import { loginStatus, isPlatformLoggedIn, exportCookiesTxt } from "../modules/chromeDriverless.js";
import { adaptSearchItem } from "../modules/searchAdapter.js";
import { recordSearch, listSearches, listMusicFiles, getStats, upsertPlatformStatus } from "../modules/db.js";
import { getJob } from "../modules/store.js";
import { YTDLP_BIN, getBinaryRuntimeEnv } from "../modules/binaries.js";
import { getExtraArgs } from "../modules/config.js";
import { resolveQqMusicStreamUrl } from "../modules/platform.js";

const router = express.Router();

const BASE_DIR = process.env.DATA_DIR || process.cwd();
const COOKIES_FILE =
  String(process.env.YTDLP_COOKIES || "").trim() ||
  path.join(BASE_DIR, "cookies", "cookies.txt");

const cdUrl = () => String(process.env.CHROME_DRIVERLESS_URL || "").trim().replace(/\/+$/, "");
// Internal (interface) address, e.g. https://browser.internal.example/ — used
// by the media tab to reach the built-in browser panel from the same network.
// Read dynamically so Settings changes apply without a restart.
const browserInternalUrl = () => String(process.env.CHROME_DRIVERLESS_INTERNAL_URL || "").trim();
// External (public) address, e.g. https://browser.public.example/ — what
// logins / the embedded browser panel resolve to for end users.
const browserExternalUrl = () => String(process.env.CHROME_DRIVERLESS_EXTERNAL_URL || "").trim();

// True when running the bundled image variant (chrome-driverless baked into
// the same image); the settings UI then locks the remote browser config.
const browserBundled = () =>
  ["1", "true", "yes", "on"].includes(String(process.env.CHROME_DRIVERLESS_BUNDLED || "").toLowerCase());

// User-configurable download folder (saved via Settings → MEDIA_DOWNLOAD_DIR).
// Falls back to the default <data>/outputs directory.
const mediaDownloadDir = () => {
  const configured = String(process.env.MEDIA_DOWNLOAD_DIR || "").trim();
  return configured ? path.resolve(configured) : path.join(BASE_DIR, "outputs");
};

// Deep-link targets: clicking a platform login button opens this page inside
// the embedded browser. For the China platforms these are the QR-code login
// pages (Bilibili/NetEase/QQ), YouTube/Spotify go to their sign-in pages.
const PLATFORM_LOGIN_URLS = {
  bilibili: "https://passport.bilibili.com/login",
  qqmusic:
    "https://graph.qq.com/oauth2.0/show?which=Login&display=pc&client_id=100460100&response_type=code&redirect_uri=https%3A%2F%2Fy.qq.com%2Fportal%2Fplayer.html",
  netease: "https://music.163.com/#/login",
  youtube: "https://www.youtube.com/signin",
  spotify: "https://accounts.spotify.com/login"
};

// Web players per platform, opened in a new browser tab from the home page.
const PLATFORM_PLAYER_URLS = {
  bilibili: "https://www.bilibili.com/",
  qqmusic: "https://y.qq.com/n/ryqq/player",
  netease: "https://music.163.com/",
  youtube: "https://music.youtube.com/",
  spotify: "https://open.spotify.com/"
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

// Browser MCP helpers (task-tab based, serialized, always close their tab).
import { cdCall, cdEvaluate, withTaskTab } from "../modules/cdBrowser.js";

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
      type: "song",
      title: stripHtml(s.songname || s.name || ""),
      artist: singers,
      album: stripHtml(s.albumname || ""),
      durationSec: Number(s.interval) || null,
      url: `https://y.qq.com/n/ryqq/songDetail/${songmid}`,
      // raw fields for the search adapter (vip / quality hints)
      pay: s.pay || null,
      size_flac: s.size_flac,
      size_320: s.size_320,
      size_128: s.size_128,
      albummid: s.albummid || null
    };
  }).filter((it) => it.id && it.title);
}

// Playlist (歌单) search — NetEase uses search type 1000.
async function searchNeteasePlaylists(keyword, limit) {
  const data = await curlJson("https://music.163.com/api/search/get", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Referer: "https://music.163.com/",
      Cookie: "os=pc"
    },
    data: `s=${encodeURIComponent(keyword)}&type=1000&offset=0&total=true&limit=${limit}`
  });
  const lists = data?.result?.playlists || [];
  return lists.map((p) => ({
    id: String(p.id),
    platform: "netease",
    type: "playlist",
    title: stripHtml(p.name || ""),
    artist: stripHtml(p.creator?.nickname || ""),
    trackCount: Number(p.trackCount) || null,
    durationSec: null,
    url: `https://music.163.com/#/playlist?id=${p.id}`
  })).filter((it) => it.id && it.title && it.url);
}

// Playlist (歌单) search — QQ Music desktop search CGI runs inside the embedded
// browser (its cookies satisfy the login-gated CGI); search_type 3 = playlist.
async function searchQqMusicPlaylists(keyword, limit) {
  // The fetch must run on a y.qq.com page (same-origin + cookies), inside
  // its own task tab.
  return withTaskTab("https://y.qq.com/", "gharmonize-qq-playlist-search", async (index) => {
    await sleep(2_000);
    const expression = `(async () => {
      try {
        const r = await fetch("https://u.y.qq.com/cgi-bin/musicu.fcg", {
          method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            comm: { ct: 19, cv: 1873 },
            req: { module: "music.search.SearchCgiService", method: "DoSearchForQQMusicDesktop",
                   param: { search_type: 3, query: ${JSON.stringify(keyword)}, page_num: 1, num_per_page: ${limit} } }
          })
        });
        const j = await r.json();
        const body = (j && j.req && j.req.data && j.req.data.body) || {};
        const list = (body.songlist && body.songlist.list) || (body.playlist && body.playlist.list) || [];
        return { ok: true, list: list.map((p) => ({
          dissid: p.dissid ?? p.disstid ?? p.mid ?? p.id ?? "",
          title: p.dissname || p.title || p.name || "",
          nick: (p.creator && (p.creator.nick || p.creator.name)) || p.nickname || "",
          cnt: p.song_count ?? p.song_cnt ?? p.songnum ?? null
        })) };
      } catch (e) { return { ok: false, error: String(e).slice(0, 140) }; }
    })()`;
    const data = await cdEvaluate(expression, 45_000, index);
    if (!data || data.ok !== true) {
      throw new Error(`QQ音乐歌单搜索失败: ${(data && data.error) || "no data"}`);
    }
    return (data.list || []).map((p) => {
      const pid = String(p.dissid ?? "");
      return {
        id: pid,
        platform: "qqmusic",
        type: "playlist",
        title: stripHtml(p.title || ""),
        artist: stripHtml(p.nick || ""),
        trackCount: Number(p.cnt) || null,
        durationSec: null,
        url: pid ? `https://y.qq.com/n/ryqq/playlist/${pid}` : ""
      };
    }).filter((it) => it.id && it.title && it.url);
  });
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
    type: "song",
    title: stripHtml(s.name || s.title || ""),
    artist: (s.artists || []).map((a) => a.name).join(" / "),
    album: stripHtml(s.album?.name || s.albumname || ""),
    durationSec: Math.round((Number(s.duration) || 0) / 1000) || null,
    // raw fields for the search adapter (vip hint) + cover
    fee: s.fee,
    albumPic: s.album?.picUrl || null,
    // Plain path (no "/#/") — the hash part never reaches yt-dlp / the server.
    url: `https://music.163.com/song?id=${s.id}`
  })).filter((it) => it.id && it.title);
}

async function searchYoutube(keyword, limit) {
  // YouTube search via yt-dlp (ytsearchN:<query>); works with the saved cookies.
  const data = await ytdlpFlatJson(`ytsearch${Math.min(limit, 30)}:${keyword}`);
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  return entries.map((e) => ({
    id: String(e.id || ""),
    platform: "youtube",
    type: "song",
    title: stripHtml(e.title || ""),
    artist: stripHtml(e.uploader || e.channel || ""),
    album: "",
    durationSec: Number(e.duration) || null,
    url: e.id ? `https://www.youtube.com/watch?v=${e.id}` : "",
    // raw fields for the search adapter
    uploader_id: e.uploader_id || null,
    view_count: e.view_count || null,
    thumbnails: Array.isArray(e.thumbnails) ? e.thumbnails : null
  })).filter((it) => it.id && it.title && it.url);
}

async function searchBilibili(keyword, limit) {
  // api.bilibili.com blocks non-browser clients (risk-control HTML page), so
  // the query runs inside the embedded browser context with its real Chrome
  // fingerprint and login cookies — in a dedicated task tab.
  return withTaskTab("https://www.bilibili.com/", "gharmonize-bili-search", async (index) => {
    await sleep(2_000); // let the SPA boot / risk-control cookie settle
    const expression = `(async () => {
      const r = await fetch("https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(
        keyword
      )}&page=1", { credentials: "include", headers: { "Accept": "application/json" } });
      const j = await r.json();
      return j;
    })()`;
    const data = await cdEvaluate(expression, 45000, index);
    if (!data || data.code !== 0 || !Array.isArray(data?.data?.result)) {
      const msg = data?.message || `bilibili search code ${data?.code ?? "?"}`;
      throw new Error(`Bilibili 搜索失败: ${msg}`);
    }
    return data.data.result.slice(0, limit).map((v) => ({
      id: v.bvid,
      platform: "bilibili",
      type: "song",
      title: stripHtml(v.title),
      artist: stripHtml(v.author || ""),
      album: "",
      durationSec: parseDurationToSec(v.duration),
      url: `https://www.bilibili.com/video/${v.bvid}/`,
      // raw fields for the search adapter
      desc: v.description || v.desc || null,
      play: v.play || null,
      pic: v.pic || null
    })).filter((it) => it.id && it.title);
  });
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
// Live platform login / VIP probes
//
// The cookie-file based loginStatus() only sees the profile snapshot saved by
// the browser, so a fresh login inside the embedded browser is invisible until
// the profile is saved again. Instead we run a tiny JS probe inside the
// embedded browser itself (shared cookie jar / session) for each platform.
// ---------------------------------------------------------------------------

const LIVE_STATUS_TTL_MS = 45_000;
let liveStatusCache = { at: 0, platforms: null };

// Each probe opens a background tab on the platform, runs `js` there (same
// origin fetch carries the login cookies), then closes the tab.
const PLATFORM_PROBES = {
  bilibili: {
    url: "https://www.bilibili.com/",
    js: `async () => {
      try {
        const r = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
        const j = await r.json();
        const d = (j && j.data) || {};
        const vip = Number(d.vipStatus) === 1;
        return { loggedIn: !!d.isLogin, vip, vipLabel: vip ? '大会员' : '', uname: d.uname || '' };
      } catch (e) { return { loggedIn: false, vip: false, vipLabel: '', error: String(e).slice(0, 100) }; }
    }`
  },
  qqmusic: {
    url: "https://y.qq.com/",
    js: `async () => {
      try {
        const ck = document.cookie || '';
        const pick = (n) => { const m = ck.match(new RegExp('(?:^|;\\\\s*)' + n + '=([^;]+)')); return m ? decodeURIComponent(m[1]) : ''; };
        const uin = pick('uin') || pick('wxuin') || pick('uinA');
        const key = pick('qqmusic_key');
        let loggedIn = (!!key && key !== '') || (!!uin && uin !== '0' && uin !== '');
        let vip = false, vipLabel = '', uname = '';
        try {
          const r = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ comm: { ct: 19, cv: 1873, uin: Number(uin) || 0 }, req: { module: 'music.userInfo.UserInfoCgi', method: 'GetUserInfo', param: {} } })
          });
          const j = await r.json();
          const d = (j && j.req && j.req.data) || {};
          const u = d.userInfo || d.user || d;
          uname = u.nick || u.nickname || uname;
          const vt = Number((u.vipInfo && (u.vipInfo.viptype ?? u.vipInfo.vipType)) ?? u.vipType ?? u.viptype ?? 0);
          if (vt > 0) { vip = true; vipLabel = '豪华绿钻'; }
          if (uname) loggedIn = true;
        } catch (e) {}
        return { loggedIn: !!loggedIn, vip, vipLabel, uname: uname || '' };
      } catch (e) { return { loggedIn: false, vip: false, vipLabel: '', error: String(e).slice(0, 100) }; }
    }`
  },
  netease: {
    url: "https://music.163.com/",
    js: `async () => {
      try {
        const r = await fetch('/api/nuser/account/get', { credentials: 'include' });
        const j = await r.json();
        const p = (j && j.profile) || null;
        const red = p ? Number(p.redVipLevel) > 0 : false;
        const vip = !!p && (red || Number(p.vipType) > 0);
        return { loggedIn: !!p, vip, vipLabel: red ? '黑胶VIP' : (vip ? '音乐VIP' : ''), uname: (p && p.nickname) || '' };
      } catch (e) { return { loggedIn: false, vip: false, vipLabel: '', error: String(e).slice(0, 100) }; }
    }`
  },
  youtube: {
    url: "https://www.youtube.com/",
    js: `async () => {
      try {
        const ck = document.cookie || '';
        const has = (re) => re.test(ck);
        const loggedIn = has(/(?:^|;\\s*)SID=/) || has(/(?:^|;\\s*)SAPISID=/) || has(/(?:^|;\\s*)__Secure-[13]PAPISID=/);
        let uname = '', vip = false, vipLabel = '', premiumTitles = [];
        // Account name via innertube accounts_list (robust against DOM changes).
        try {
          const get = (k) => window.ytcfg ? (typeof window.ytcfg.get === 'function' ? window.ytcfg.get(k) : (window.ytcfg.data_ || {})[k]) : undefined;
          const ctx = get('INNERTUBE_CONTEXT');
          const key = get('INNERTUBE_API_KEY');
          if (ctx && key) {
            const r = await fetch('https://www.youtube.com/youtubei/v1/account/accounts_list?key=' + encodeURIComponent(key) + '&prettyPrint=false', {
              method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ context: ctx })
            });
            const j = await r.json();
            const cards = ((((j || {}).contents || [])[0] || {}).accountPickerSectionRenderer || {}).contents || [];
            const items = (((cards[0] || {}).accountItemSectionRenderer || {}).contents) || [];
            for (const c of items) {
              const air = (c || {}).accountItemRenderer;
              if (!air) continue;
              const nm = (air.accountName && (air.accountName.simpleText || (air.accountName.runs || []).map((x) => x.text).join(''))) || '';
              if (nm && (air.isSelected || !uname)) uname = nm;
              if (air.isSelected && nm) break;
            }
          }
        } catch (e) {}
        // Premium best-effort: the sidebar guide carries a /premium entry.
        // Non-members always see an upsell CTA (Get/Try/Free, 获取/开通/试用);
        // members see benefits/manage wording instead.
        try {
          const visit = (node, depth) => {
            if (!node || typeof node !== 'object' || depth > 24) return;
            if (Array.isArray(node)) { for (const n of node) visit(n, depth + 1); return; }
            if (node.guideEntryRenderer) {
              const nav = node.guideEntryRenderer.navigationEndpoint || {};
              const url = ((nav.urlEndpoint || {}).url) || (((nav.commandMetadata || {}).webCommandMetadata || {}).url) || '';
              if (/(^|=|\\/)premium($|\\?|&)/.test(String(url))) {
                const t = node.guideEntryRenderer.formatedTitle || node.guideEntryRenderer.title || {};
                const txt = t.simpleText || (t.runs || []).map((x) => x.text).join('') || '';
                if (txt) premiumTitles.push(txt);
              }
            }
            for (const k of Object.keys(node)) visit(node[k], depth + 1);
          };
          let data = window.ytInitialData;
          if (!data) {
            const get = (k) => window.ytcfg ? (typeof window.ytcfg.get === 'function' ? window.ytcfg.get(k) : (window.ytcfg.data_ || {})[k]) : undefined;
            const ctx = get('INNERTUBE_CONTEXT');
            const key = get('INNERTUBE_API_KEY');
            if (ctx && key) {
              const r = await fetch('https://www.youtube.com/youtubei/v1/guide?key=' + encodeURIComponent(key) + '&prettyPrint=false', {
                method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ context: ctx })
              });
              data = await r.json();
            }
          }
          visit(data, 0);
          const upsell = /(get|try|free|trial|upgrade|join|obtener|prueba|gratis|probar|essai|essayer|gratuit|kostenlos|testen|ücretsiz|deneme|dene|katıl|yükselt|获取|獲取|开通|開通|免费|免費|试用|試用|加入|体验|體驗|升级|升級)/i;
          const member = /(benefits|manage|member|your premium|权益|權益|权限|權限|管理|会员|會員|已加入|已开通|已開通|已购买|已購買)/i;
          for (const t of premiumTitles) {
            if (member.test(t)) { vip = true; break; }
          }
          if (!vip && premiumTitles.length) vip = !premiumTitles.every((t) => upsell.test(t));
          if (vip) vipLabel = 'Premium';
        } catch (e) {}
        return { loggedIn, vip, vipLabel, uname };
      } catch (e) { return { loggedIn: false, vip: false, vipLabel: '', error: String(e).slice(0, 100) }; }
    }`
  },
  spotify: {
    url: "https://open.spotify.com/",
    js: `async () => {
      try {
        let loggedIn = false, uname = '', product = '', token = '';
        try {
          const r = await fetch('https://open.spotify.com/get_access_token?reason=transport&productType=web_player', { credentials: 'include' });
          const j = await r.json();
          if (j && j.accessToken) {
            token = j.accessToken;
            if (j.isAnonymous === false) loggedIn = true;
            product = String(j.product || '').toLowerCase();
          }
        } catch (e) {}
        if (!loggedIn && /(?:^|;\\s*)sp_dc=/.test(document.cookie || '')) loggedIn = true;
        if (token) {
          try {
            const me = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: 'Bearer ' + token } });
            if (me.ok) {
              const m = await me.json();
              uname = m.display_name || m.email || '';
              if (m.product) product = String(m.product).toLowerCase();
              if (m.product && m.product !== 'free' && m.product !== 'open') loggedIn = true;
            }
          } catch (e) {}
        }
        const vip = product === 'premium';
        return { loggedIn, vip, vipLabel: vip ? 'Premium' : '', uname, product };
      } catch (e) { return { loggedIn: false, vip: false, vipLabel: '', error: String(e).slice(0, 100) }; }
    }`
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Opens one background tab for the probe and always closes it afterwards.
async function probePlatform(key, spec) {
  return withTaskTab(spec.url, `gharmonize-probe-${key}`, async (index) => {
    await sleep(2_000); // let the SPA boot / cookie context settle
    const value = await cdEvaluate(spec.js, 20_000, index);
    if (!value || typeof value !== "object") throw new Error("probe returned no object");
    return value;
  });
}

// Merges live probes over the cookie-file based status; falls back cleanly.
// All probes run through one serial queue: each probe drives the browser's
// active tab, so concurrent probes would race each other.
let liveStatusQueue = Promise.resolve();
function livePlatformStatus({ refresh = false, platform = null } = {}) {
  const base = loginStatus().platforms;
  const targets = platform ? [String(platform).toLowerCase()] : Object.keys(PLATFORM_PROBES);
  const cached = liveStatusCache.platforms;
  // Full sync serves from cache while fresh (unless refresh); per-platform
  // checks always run so the channel button gives a genuinely fresh answer.
  if (!platform && !refresh && cached && Date.now() - liveStatusCache.at < LIVE_STATUS_TTL_MS) {
    return Promise.resolve(cached);
  }

  const run = async () => {
    let merged = { ...(liveStatusCache.platforms || base) };
    for (const key of targets) {
      const spec = PLATFORM_PROBES[key];
      if (!spec) continue;
      try {
        const probe = await probePlatform(key, spec);
        merged[key] = {
          ...(merged[key] || {}),
          ...probe,
          source: "live",
          loggedIn: !!probe.loggedIn || !!base[key]?.loggedIn
        };
      } catch {
        // Browser not running / CD unavailable: keep the cookie-file status.
        merged[key] = { ...(merged[key] || {}), source: "cookies" };
      }
    }
    liveStatusCache = { at: Date.now(), platforms: merged };
    // Persist the latest probe snapshot into SQLite (platform_status table).
    for (const key of targets) {
      if (merged[key]) upsertPlatformStatus(key, merged[key]);
    }
    // Refresh the yt-dlp cookie exports alongside every status probe so fresh
    // logins in the embedded browser are usable by downloads immediately.
    try { exportCookiesTxt(); } catch { /* non-fatal */ }
    return merged;
  };

  const job = liveStatusQueue.then(run, run);
  liveStatusQueue = job.catch(() => {});
  return job;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get("/api/media/config", rateLimit(60, 60_000), (_req, res) => {
  res.json({
    ok: true,
    platforms: loginStatus().platforms,
    loginUrls: PLATFORM_LOGIN_URLS,
    playerUrls: PLATFORM_PLAYER_URLS,
    browserUrl: cdUrl() || null,
    browserExternalUrl: browserExternalUrl() || null,
    browserInternalUrl: browserInternalUrl() || null,
    browserBundled: browserBundled(),
    downloadDir: mediaDownloadDir()
  });
});

// Batched job status for the home download queue UI: one poll covers every
// submitted item (progress %, phase, error reason).
router.get("/api/media/jobs-status", rateLimit(240, 60_000), (req, res) => {
  const ids = String(req.query.ids || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 80);
  const jobs = ids.map((id) => {
    const j = getJob(id);
    if (!j) return { id, status: "missing", progress: 0, error: null };
    return {
      id,
      status: String(j.status || "queued"),
      progress: Number(j.progress) || 0,
      currentPhase: j.currentPhase || null,
      error: j.error ? String(j.error).slice(0, 400) : null,
      resultPath: j.resultPath || null,
      title: j.metadata?.frozenTitle || j.metadata?.extracted?.title || j.metadata?.originalName || null
    };
  });
  res.json({ ok: true, jobs });
});

// SQLite-backed history: recent searches, finished music library, counters.
router.get("/api/media/history", requireAuth, rateLimit(60, 60_000), (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  res.json({
    ok: true,
    searches: listSearches({ limit }),
    musicFiles: listMusicFiles({ limit }),
    stats: getStats()
  });
});

router.get("/api/media/login-status", rateLimit(120, 60_000), async (req, res) => {
  const refresh = ["1", "true"].includes(String(req.query.refresh || "").toLowerCase());
  const platform = String(req.query.platform || "").trim().toLowerCase() || null;
  try {
    const platforms = await livePlatformStatus({ refresh, platform });
    res.json({ ok: true, platform, platforms });
  } catch (e) {
    // Never fail the status endpoint; degrade to the cookie-file snapshot.
    res.json({ ok: true, platforms: loginStatus().platforms, degraded: true });
  }
});

router.get("/api/media/search", rateLimit(30, 60_000), async (req, res) => {
  const platform = String(req.query.platform || "").toLowerCase();
  const keyword = String(req.query.keyword || "").trim();
  const type = String(req.query.type || "song").trim().toLowerCase() === "playlist" ? "playlist" : "song";
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
      items = type === "playlist"
        ? await searchQqMusicPlaylists(keyword, limit)
        : await searchQqMusic(keyword, limit);
    } else if (platform === "netease") {
      items = type === "playlist"
        ? await searchNeteasePlaylists(keyword, limit)
        : await searchNetease(keyword, limit);
    } else if (platform === "youtube") {
      if (type === "playlist") {
        items = []; // YouTube playlist search is not supported in aggregated search.
      } else {
        items = await searchYoutube(keyword, limit);
      }
    } else if (platform === "bilibili") {
      if (type === "playlist") {
        items = []; // Bilibili has no playlist search; use 链接解析 for collections.
      } else {
        if (!loginGate("Bilibili（哔哩哔哩）")) return;
        items = await searchBilibili(keyword, limit);
      }
    } else {
      return res.status(400).json({ error: { code: "UNKNOWN_PLATFORM", message: "platform must be qqmusic | netease | bilibili | youtube" } });
    }
    // Adapter pass: normalize every platform's raw payload into the rich
    // common shape (vip / fileFormat / quality / creators / description…).
    items = items.map((it) => adaptSearchItem(it));
    // Durable history in SQLite (searches + search_items tables).
    recordSearch({ keyword, platform, searchType: type, items });
    res.json({ ok: true, platform, type, keyword, count: items.length, items });
  } catch (err) {
    console.warn(`[media] search ${platform} failed:`, err?.message || err);
    res.status(502).json({ error: { code: "SEARCH_FAILED", message: err?.message || "search failed" } });
  }
});

// Preview streaming: proxies the actual audio bytes to the browser's <audio>
// element (redirects would lose the Referer some CDNs require, and NetEase's
// outer URL returns an HTML upsell page for VIP songs).
router.get("/api/media/stream", rateLimit(30, 60_000), async (req, res) => {
  const platform = String(req.query.platform || "").trim();
  const id = String(req.query.id || "").trim();
  if (!platform || !id) {
    return res.status(400).json({ error: { code: "BAD_REQUEST", message: "platform and id are required" } });
  }
  const notFound = (message) => res.status(404).json({ error: { code: "PREVIEW_FAILED", message } });
  try {
    let upstream;
    if (platform === "netease") {
      upstream = await fetch(`https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`, { redirect: "follow" });
    } else if (platform === "qqmusic") {
      const info = await resolveQqMusicStreamUrl(`https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(id)}`);
      upstream = await fetch(info.purl, { redirect: "follow", headers: { Referer: "https://y.qq.com/", "User-Agent": UA } });
    } else {
      return notFound("no preview stream for this platform");
    }
    const ct = String(upstream.headers.get("content-type") || "");
    if (!upstream.ok || (!ct.includes("audio") && !ct.includes("octet-stream") && !ct.includes("video"))) {
      return notFound("preview unavailable for this song");
    }
    res.setHeader("Content-Type", ct);
    if (upstream.headers.get("content-length")) res.setHeader("Content-Length", upstream.headers.get("content-length"));
    res.setHeader("Cache-Control", "no-store");
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    console.warn(`[media] stream ${platform}/${id} failed:`, err?.message || err);
    return notFound(err?.message || "preview unavailable");
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
      let host = "";
      try { host = new URL(url).hostname.toLowerCase(); } catch { /* fallthrough */ }
      const isQq = host.includes("qq.com");
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
        if (isQq) {
          // QQ Music playlist entries are individual songs.
          return {
            id: e.id || String(i + 1),
            index: pagePart,
            title: stripHtml(e.title || `Track ${pagePart}`),
            artist: stripHtml(e.uploader || e.artist || ""),
            durationSec: Number(e.duration) || null,
            url: e.id ? `https://y.qq.com/n/ryqq/songDetail/${e.id}` : url
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
