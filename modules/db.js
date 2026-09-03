// SQLite persistence (better-sqlite3, WAL) for everything that used to live
// only in memory or ad-hoc JSON files:
//   - jobs            → durable download job history (was cache/jobs-state.json)
//   - music_files     → finished audio library (one row per produced file)
//   - searches        → aggregated-search history
//   - search_items    → adapter-normalized search results per search
//   - platform_status → latest live login/VIP probe per platform
// The database file lives under DATA_DIR/db/ so it is volume-mounted both in
// local dev and on the NAS (DATA_DIR=/data → /data/db/gharmonize.db).
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { resolveDownloadPathToAbs } from "./outputPaths.js";

const BASE_DIR = process.env.DATA_DIR || process.cwd();
const DB_DIR = process.env.GHARMONIZE_DB_DIR || path.join(BASE_DIR, "db");
const DB_PATH = path.join(DB_DIR, "gharmonize.db");

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  url              TEXT,
  platform         TEXT,
  media_kind       TEXT,
  title            TEXT,
  artist           TEXT,
  album            TEXT,
  format           TEXT,
  bitrate          TEXT,
  sample_rate      INTEGER,
  status           TEXT,
  progress         INTEGER DEFAULT 0,
  current_phase    TEXT,
  error            TEXT,
  result_path      TEXT,
  result_size_bytes INTEGER,
  is_playlist      INTEGER DEFAULT 0,
  selected_indices TEXT,
  client_batch     TEXT,
  batch_total      INTEGER,
  meta_json        TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  finished_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_platform ON jobs(platform);

CREATE TABLE IF NOT EXISTS music_files (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  title        TEXT,
  artist       TEXT,
  album        TEXT,
  platform     TEXT,
  source_url   TEXT,
  file_path    TEXT UNIQUE,
  file_format  TEXT,
  size_bytes   INTEGER,
  duration_sec REAL,
  meta_json    TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_music_files_job ON music_files(job_id);

CREATE TABLE IF NOT EXISTS searches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword      TEXT NOT NULL,
  platform     TEXT,
  search_type  TEXT,
  result_count INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_searches_created ON searches(created_at DESC);

CREATE TABLE IF NOT EXISTS search_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id     INTEGER REFERENCES searches(id) ON DELETE CASCADE,
  platform      TEXT,
  ext_id        TEXT,
  title         TEXT,
  artists       TEXT,
  album         TEXT,
  duration_sec  REAL,
  vip           INTEGER DEFAULT 0,
  file_format   TEXT,
  description   TEXT,
  creators_json TEXT,
  cover_url     TEXT,
  page_url      TEXT,
  raw_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_search_items_search ON search_items(search_id);

CREATE TABLE IF NOT EXISTS platform_status (
  platform    TEXT PRIMARY KEY,
  logged_in   INTEGER DEFAULT 0,
  vip         INTEGER DEFAULT 0,
  vip_label   TEXT,
  uname       TEXT,
  source      TEXT,
  detail_json TEXT,
  checked_at  TEXT NOT NULL
);
`;

function nowIso() {
  return new Date().toISOString();
}

export function getDb() {
  if (db) return db;
  fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o755 });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  db.prepare(
    "INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, ?)"
  ).run(nowIso());
  return db;
}

// Never let persistence problems take the app down.
function safe(fn, fallback = null) {
  try {
    return fn();
  } catch (e) {
    console.warn(`[db] ${fn.name || "op"} failed:`, e?.message || e);
    return fallback;
  }
}

// Coerces a bind value into something SQLite accepts (better-sqlite3 rejects
// booleans, objects, Dates and undefined — coerce instead of throwing).
function bindable(v) {
  if (v === undefined || v === null) return null;
  const t = typeof v;
  if (t === "boolean") return v ? 1 : 0;
  if (t === "number") return Number.isFinite(v) ? v : null;
  if (t === "bigint") return v;
  if (t === "string") return v;
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

export function upsertJob(job) {
  if (!job?.id) return;
  const now = nowIso();
  safe(() => {
    const p = Object.fromEntries(Object.entries({
      url: job.url || null,
      platform: job.platform || null,
      media_kind: job.mediaKind || (job.isPlaylist ? "playlist" : "song"),
      title: job.title || null,
      artist: job.artist || null,
      album: job.album || null,
      format: job.format || null,
      bitrate: job.bitrate || null,
      sample_rate: job.sampleRate ?? null,
      status: job.status || "queued",
      progress: Math.round(Number(job.progress) || 0),
      current_phase: job.currentPhase || null,
      error: job.error ? String(job.error).slice(0, 1000) : null,
      result_path: job.resultPath || null,
      result_size_bytes: job.resultSizeBytes ?? null,
      is_playlist: job.isPlaylist ? 1 : 0,
      selected_indices: job.selectedIndices ? JSON.stringify(job.selectedIndices) : null,
      client_batch: job.clientBatch || null,
      batch_total: job.batchTotal ?? null,
      meta_json: job.meta ? JSON.stringify(job.meta).slice(0, 4000) : null,
      created_at: job.createdAt || now,
      updated_at: now,
      finished_at: ["completed", "error", "canceled"].includes(job.status) ? (job.finishedAt || now) : null,
      id: job.id
    }).map(([k, v]) => [k, bindable(v)]));
    getDb().prepare(`
      INSERT INTO jobs (id, url, platform, media_kind, title, artist, album,
        format, bitrate, sample_rate, status, progress, current_phase, error,
        result_path, result_size_bytes, is_playlist, selected_indices,
        client_batch, batch_total, meta_json, created_at, updated_at, finished_at)
      VALUES (@id, @url, @platform, @media_kind, @title, @artist, @album,
        @format, @bitrate, @sample_rate, @status, @progress, @current_phase, @error,
        @result_path, @result_size_bytes, @is_playlist, @selected_indices,
        @client_batch, @batch_total, @meta_json, @created_at, @updated_at, @finished_at)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status, progress=excluded.progress,
        current_phase=excluded.current_phase, error=excluded.error,
        result_path=excluded.result_path, result_size_bytes=excluded.result_size_bytes,
        updated_at=excluded.updated_at, finished_at=excluded.finished_at
    `).run(p);
  });
}

// ---------------------------------------------------------------------------
// music_files — one row per finished file
// ---------------------------------------------------------------------------

export function insertMusicFile(entry) {
  // job.resultPath comes in many shapes: a plain "/download/…" string, a
  // {outputPath} object, an array of result objects, or a JSON blob string.
  let fp = entry?.filePath;
  if (Array.isArray(fp)) fp = fp[0];
  if (fp && typeof fp === "object") fp = fp.outputPath || fp.path || null;
  fp = fp == null ? "" : String(fp);
  if (fp.startsWith("{")) {
    try { fp = String(JSON.parse(fp).outputPath || fp); } catch { /* keep raw */ }
  }
  try { fp = decodeURIComponent(fp); } catch { /* already decoded */ }
  if (!fp.startsWith("/download/")) return; // reject garbage like "[object Object]"
  entry = { ...entry, filePath: fp };
  // Derive a sane format token ("mp3", "flac", …); processor values may be objects.
  const ffRaw = entry.fileFormat != null ? String(entry.fileFormat) : (fp.split(".").pop() || "");
  const fileFormat = /^[a-z0-9]{1,5}$/i.test(ffRaw.trim()) ? ffRaw.trim().toLowerCase() : null;
  // Fill in the real size from disk when the job doesn't carry one.
  let sizeBytes = entry.sizeBytes;
  if (sizeBytes == null) {
    try { sizeBytes = fs.statSync(resolveDownloadPathToAbs(fp) || fp).size; } catch { /* best-effort */ }
  }
  safe(() => {
    const p = Object.fromEntries(Object.entries({
      job_id: entry.jobId || null,
      title: entry.title || null,
      artist: entry.artist || null,
      album: entry.album || null,
      platform: entry.platform || null,
      source_url: entry.sourceUrl || null,
      file_path: entry.filePath,
      file_format: fileFormat,
      size_bytes: sizeBytes ?? null,
      duration_sec: entry.durationSec ?? null,
      meta_json: entry.meta ? JSON.stringify(entry.meta).slice(0, 8000) : null,
      created_at: nowIso()
    }).map(([k, v]) => [k, bindable(v)]));
    getDb().prepare(`
      INSERT INTO music_files (job_id, title, artist, album, platform, source_url,
        file_path, file_format, size_bytes, duration_sec, meta_json, created_at)
      VALUES (@job_id, @title, @artist, @album, @platform, @source_url,
        @file_path, @file_format, @size_bytes, @duration_sec, @meta_json, @created_at)
      ON CONFLICT(file_path) DO UPDATE SET
        title=excluded.title, artist=excluded.artist, album=excluded.album,
        size_bytes=excluded.size_bytes, meta_json=excluded.meta_json
    `).run(p);
  });
}

export function listMusicFiles({ limit = 100 } = {}) {
  return safe(() => getDb().prepare(
    "SELECT * FROM music_files ORDER BY created_at DESC, id DESC LIMIT ?"
  ).all(Math.max(1, Math.min(500, Number(limit) || 100))), []);
}

// ---------------------------------------------------------------------------
// searches + adapter-normalized items
// ---------------------------------------------------------------------------

export function recordSearch({ keyword, platform, searchType, items = [] }) {
  return safe(() => {
    const now = nowIso();
    const info = getDb().prepare(`
      INSERT INTO searches (keyword, platform, search_type, result_count, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(String(keyword || "").slice(0, 300), platform || null, searchType || "song", items.length, now);
    const searchId = info.lastInsertRowid;
    if (items.length) {
      const ins = getDb().prepare(`
        INSERT INTO search_items (search_id, platform, ext_id, title, artists, album,
          duration_sec, vip, file_format, description, creators_json, cover_url, page_url, raw_json)
        VALUES (@search_id, @platform, @ext_id, @title, @artists, @album,
          @duration_sec, @vip, @file_format, @description, @creators_json, @cover_url, @page_url, @raw_json)
      `);
      const tx = getDb().transaction((rows) => {
        for (const it of rows) {
          ins.run(Object.fromEntries(Object.entries({
            search_id: searchId,
            platform: it.platform || platform || null,
            ext_id: it.id ? String(it.id) : null,
            title: it.title || null,
            artists: it.artist || null,
            album: it.album || null,
            duration_sec: it.durationSec ?? null,
            vip: it.vip ? 1 : 0,
            file_format: it.fileFormat || null,
            description: it.description || null,
            creators_json: it.creators ? JSON.stringify(it.creators) : null,
            cover_url: it.cover || null,
            page_url: it.url || null,
            raw_json: safe(() => JSON.stringify(it).slice(0, 4000), null)
          }).map(([k, v]) => [k, bindable(v)])));
        }
      });
      tx(items.slice(0, 60));
    }
    return searchId;
  });
}

export function listSearches({ limit = 50 } = {}) {
  return safe(() => getDb().prepare(
    "SELECT * FROM searches ORDER BY created_at DESC, id DESC LIMIT ?"
  ).all(Math.max(1, Math.min(200, Number(limit) || 50))), []);
}

// ---------------------------------------------------------------------------
// platform_status — latest live probe snapshot per platform
// ---------------------------------------------------------------------------

export function upsertPlatformStatus(platform, info) {
  if (!platform) return;
  safe(() => {
    getDb().prepare(`
      INSERT INTO platform_status (platform, logged_in, vip, vip_label, uname, source, detail_json, checked_at)
      VALUES (@platform, @logged_in, @vip, @vip_label, @uname, @source, @detail_json, @checked_at)
      ON CONFLICT(platform) DO UPDATE SET
        logged_in=excluded.logged_in, vip=excluded.vip, vip_label=excluded.vip_label,
        uname=excluded.uname, source=excluded.source, detail_json=excluded.detail_json,
        checked_at=excluded.checked_at
    `).run(Object.fromEntries(Object.entries({
      platform,
      logged_in: info?.loggedIn ? 1 : 0,
      vip: info?.vip ? 1 : 0,
      vip_label: info?.vipLabel || null,
      uname: info?.uname || null,
      source: info?.source || null,
      detail_json: safe(() => JSON.stringify(info).slice(0, 2000), null),
      checked_at: nowIso()
    }).map(([k, v]) => [k, bindable(v)])));
  });
}

export function getPlatformStatuses() {
  return safe(() => getDb().prepare("SELECT * FROM platform_status").all(), []);
}

// ---------------------------------------------------------------------------
// stats — for the support/status report
// ---------------------------------------------------------------------------

export function getStats() {
  return safe(() => {
    const d = getDb();
    const one = (sql) => d.prepare(sql).get()?.n ?? 0;
    return {
      jobs: one("SELECT COUNT(*) n FROM jobs"),
      jobsCompleted: one("SELECT COUNT(*) n FROM jobs WHERE status='completed'"),
      jobsFailed: one("SELECT COUNT(*) n FROM jobs WHERE status IN ('error','failed','canceled')"),
      musicFiles: one("SELECT COUNT(*) n FROM music_files"),
      searches: one("SELECT COUNT(*) n FROM searches"),
      searchItems: one("SELECT COUNT(*) n FROM search_items")
    };
  }, {});
}

// Called once at boot: jobs left non-terminal by a previous process are
// resumed by store.js (URL jobs re-enqueue); only genuinely unresumable ones
// (uploads/retag with no source URL, broken spotify-map state) get marked.
export function listResumableJobs() {
  return safe(() => getDb().prepare(`
    SELECT id, url, platform, media_kind, title, artist, album, format, bitrate,
           sample_rate, status, progress, is_playlist, selected_indices, meta_json, created_at
    FROM jobs WHERE status IN ('queued','processing')
    ORDER BY created_at ASC
  `).all(), []);
}

export function markJobError(id, message) {
  return safe(() => getDb().prepare(`
    UPDATE jobs SET status='error', error=?, updated_at=?, finished_at=?
    WHERE id=?
  `).run(String(message || "error").slice(0, 1000), nowIso(), nowIso(), id).changes, 0);
}

// Recent jobs for UI queue restore after a page refresh.
export function listRecentJobs({ limit = 120 } = {}) {
  return safe(() => getDb().prepare(`
    SELECT id, url, platform, media_kind, title, artist, album, format, bitrate,
           status, progress, current_phase, error, is_playlist, created_at, updated_at
    FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(Math.max(1, Math.min(300, Number(limit) || 120))), []);
}

// Clears the whole download history (jobs + produced-file index).
export function clearAllJobs() {
  return safe(() => {
    const d = getDb();
    d.prepare("DELETE FROM music_files").run();
    const n = d.prepare("DELETE FROM jobs").run().changes;
    return { cleared: n };
  }, { cleared: 0 });
}

export default {
  getDb,
  upsertJob,
  insertMusicFile,
  listMusicFiles,
  recordSearch,
  listSearches,
  upsertPlatformStatus,
  getPlatformStatuses,
  getStats,
  listResumableJobs,
  markJobError,
  listRecentJobs,
  clearAllJobs
};
