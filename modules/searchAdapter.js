// Search-result adapter: every platform returns its own metadata shape; this
// module normalizes them into one rich item so the UI can display ALL fields a
// channel provides: source, expected file format/quality, creators, intro,
// cover, VIP requirement. Nothing is invented — fields the platform does not
// expose stay null/absent.
//
// Normalized item:
// {
//   id, platform, type: "song"|"playlist", title, artist, album,
//   durationSec, url, trackCount,
//   vip: bool,                  // full-quality download needs a VIP tier
//   fileFormat: "mp3"|"flac"|"m4a",
//   quality: string|null,       // human hint: 128k/320k/无损/m4a
//   creators: { singer, composer, lyricist, arranger, uploader } (existing only)
//   description: string|null,   // 介绍 from the channel
//   cover: string|null,
//   stats: { plays } | null
// }

function strip(v) {
  return String(v ?? "").trim() || null;
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = strip(v);
    if (s) return s;
  }
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// QQ Music search payload: pay.payplay 0=free 1=VIP; size_flac/320/128 bytes.
function adaptQqMusic(s = {}) {
  const pay = s.pay || {};
  const vip = Number(pay.payplay ?? pay.pay_play ?? 0) > 0;
  const sizeFlac = num(s.size_flac);
  const size320 = num(s.size_320);
  const size128 = num(s.size_128);
  let fileFormat = "mp3";
  let quality = size320 ? "320kbps MP3" : "128kbps MP3";
  if (vip && sizeFlac) {
    fileFormat = "flac";
    quality = "无损 FLAC";
  } else if (size128 && !size320) {
    quality = "128kbps MP3";
  }
  return {
    vip,
    fileFormat,
    quality,
    creators: { singer: firstNonEmpty((s.singer || []).map((x) => x?.name).join(" / "), s.artist) },
    description: null,
    cover: s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : null,
    stats: null
  };
}

// NetEase song: fee 0=free, 1=VIP(黑胶), 4=购买, 8=低成本免费.
function adaptNetease(s = {}) {
  const fee = Number(s.fee || 0);
  const vip = fee === 1 || fee === 4;
  return {
    vip,
    fileFormat: vip ? "flac" : "mp3",
    quality: vip ? "无损 FLAC（黑胶）" : "128/320kbps MP3",
    creators: { singer: firstNonEmpty((s.artists || []).map((a) => a?.name).join(" / "), s.artist) },
    description: null,
    cover: firstNonEmpty(s.album?.picUrl || (s.album?.pic_str ? `https://p3.music.126.net/-/y=${s.album.pic_str}.jpg` : null) || (s.album?.picId ? `https://p3.music.126.net/-/${s.album.picId}.jpg` : null)),
    stats: null
  };
}

// YouTube (yt-dlp flat entry): channel/uploader as creator; audio lands as m4a.
function adaptYoutube(e = {}) {
  return {
    vip: false,
    fileFormat: "m4a",
    quality: "m4a 音频（自动选最佳）",
    creators: { channel: firstNonEmpty(e.uploader, e.channel, e.uploader_id, e.artist) },
    description: null,
    cover: e.thumbnails?.length ? e.thumbnails[e.thumbnails.length - 1]?.url : null,
    stats: e.view_count ? { plays: num(e.view_count) } : null
  };
}

// Spotify track (Web API search): downloads land as matched MP3s.
function adaptSpotify(s = {}) {
  return {
    vip: false,
    fileFormat: "mp3",
    quality: "320kbps MP3（匹配下载）",
    creators: { artist: firstNonEmpty(s.artist) },
    description: null,
    cover: firstNonEmpty(s.cover),
    stats: null
  };
}

// Bilibili video search result: rich — author, description, play, pic.
function adaptBilibili(v = {}) {
  return {
    vip: false,
    fileFormat: "m4a",
    quality: "m4a 音频（Dash）",
    creators: { uploader: firstNonEmpty(v.author, v.owner?.name, v.artist) },
    description: strip(String(v.desc || v.description || "").replace(/<[^>]+>/g, ""))?.slice(0, 300) || null,
    cover: firstNonEmpty(v.pic?.replace(/^http:/, "https:"), v.owner?.face) ,
    stats: v.play ? { plays: num(v.play) } : null
  };
}

// Playlist variants: channels expose creator + track count.
function adaptPlaylistGeneric(it = {}, platform) {
  const creators = { uploader: firstNonEmpty(it.artist, it.nick, it.creator?.nickname) };
  const description = it.trackCount ? `歌单 · ${it.trackCount} 首` : "歌单";
  const covers = {
    qqmusic: null,
    netease: it.coverImgUrl || null,
    youtube: null,
    bilibili: null,
    spotify: it.coverImgUrl || null
  };
  return {
    vip: false,
    fileFormat: null,
    quality: null,
    creators,
    description,
    cover: covers[platform] || null,
    stats: null
  };
}

const SONG_ADAPTERS = {
  qqmusic: adaptQqMusic,
  netease: adaptNetease,
  youtube: adaptYoutube,
  bilibili: adaptBilibili,
  spotify: adaptSpotify
};

// Maps a raw (already unified-basics) search item into the rich normalized form.
export function adaptSearchItem(raw = {}) {
  const platform = raw.platform || "unknown";
  const base = {
    id: raw.id ?? null,
    platform,
    type: raw.type === "playlist" ? "playlist" : "song",
    title: raw.title || "",
    artist: raw.artist || null,
    album: raw.album || null,
    durationSec: raw.durationSec ?? null,
    trackCount: raw.trackCount ?? null,
    url: raw.url || ""
  };
  let extra;
  if (base.type === "playlist") {
    extra = adaptPlaylistGeneric(raw, platform);
  } else {
    extra = SONG_ADAPTERS[platform]?.(raw) || { vip: false, fileFormat: null, quality: null, creators: {}, description: null, cover: null, stats: null };
  }
  // Only keep creators keys the channel actually provided.
  const creators = Object.fromEntries(
    Object.entries(extra.creators || {}).filter(([, v]) => v)
  );
  return {
    ...base,
    vip: !!extra.vip,
    fileFormat: extra.fileFormat || null,
    quality: extra.quality || null,
    creators: Object.keys(creators).length ? creators : null,
    description: extra.description || null,
    cover: extra.cover || null,
    stats: extra.stats || null
  };
}

export default { adaptSearchItem };
