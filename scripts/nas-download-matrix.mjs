// Download support matrix against the NAS deployment.
const BASE = process.env.BASE || 'https://musicdownload.tailnas.friddle.me';
const out = [];

async function api(path, opts = {}) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(60000), ...opts });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, d };
}

async function search(platform, keyword, limit = 5) {
  const { d } = await api(`/api/media/search?platform=${platform}&type=song&keyword=${encodeURIComponent(keyword)}&limit=${limit}`);
  return d?.items || [];
}

async function submit(body) {
  const { d } = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return d;
}

async function poll(ids, label, maxSec = 240) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxSec * 1000) {
    await new Promise((r) => setTimeout(r, 6000));
    const { d } = await api(`/api/media/jobs-status?ids=${ids.join(',')}`);
    const jobs = d?.jobs || [];
    const line = jobs.map((j) => `${j.id.slice(4, 12)}:${j.status}:${j.progress}%`).join(' ');
    console.log(`[${label}] ${line}`);
    if (jobs.length && jobs.every((j) => ['completed', 'error', 'canceled', 'missing'].includes(j.status))) {
      return jobs.map((j) => ({ id: j.id, status: j.status, error: j.error, path: j.resultPath }));
    }
  }
  return [{ status: 'timeout' }];
}

// --- 1. QQ Music: pick a NON-vip song from candidates
const qqCandidates = [];
for (const kw of ['心太软 任贤齐', '上海滩 叶丽仪', '小苹果 筷子兄弟']) {
  qqCandidates.push(...(await search('qqmusic', kw, 3)));
  await new Promise((r) => setTimeout(r, 1200));
}
const qqFree = qqCandidates.find((i) => !i.vip && i.durationSec > 150) || qqCandidates.find((i) => !i.vip);
if (qqFree) {
  console.log(`[qq] free pick: ${qqFree.title} - ${qqFree.artist} vip=${qqFree.vip}`);
  const j = await submit({ url: qqFree.url, format: 'original', bitrate: 'auto', isPlaylist: false, sampleRate: 48000, autoCreateZip: false, title: qqFree.title, artist: qqFree.artist });
  if (j?.id) out.push({ plat: 'qqmusic', item: `${qqFree.title} - ${qqFree.artist}`, jobs: await poll([j.id], 'qq') });
  else out.push({ plat: 'qqmusic', item: qqFree.title, jobs: [{ status: 'submit-failed', error: JSON.stringify(j)?.slice(0, 200) }] });
} else out.push({ plat: 'qqmusic', jobs: [{ status: 'no-free-song-found' }] });

// --- 2. NetEase: free song
const neItems = await search('netease', '后来 刘若英', 5);
const neFree = neItems.find((i) => !i.vip && i.durationSec > 150) || neItems[0];
if (neFree) {
  console.log(`[netease] pick: ${neFree.title} - ${neFree.artist} vip=${neFree.vip}`);
  const j = await submit({ url: neFree.url, format: 'original', bitrate: 'auto', isPlaylist: false, sampleRate: 48000, autoCreateZip: false, title: neFree.title, artist: neFree.artist });
  if (j?.id) out.push({ plat: 'netease', item: `${neFree.title} - ${neFree.artist}`, jobs: await poll([j.id], 'ne') });
  else out.push({ plat: 'netease', item: neFree.title, jobs: [{ status: 'submit-failed', error: JSON.stringify(j)?.slice(0, 200) }] });
}

// --- 3. Bilibili (logged in + 大会员)
const bj = await submit({ url: 'https://www.bilibili.com/video/BV1GJ411x7h7/', format: 'original', bitrate: 'auto', isPlaylist: false, sampleRate: 48000, autoCreateZip: false, title: 'Never Gonna Give You Up', artist: 'bilibili' });
if (bj?.id) out.push({ plat: 'bilibili', item: 'BV1GJ411x7h7', jobs: await poll([bj.id], 'bili') });

// --- 4. YouTube (anonymous cookie OK for public videos)
const yt = await submit({ url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', format: 'original', bitrate: 'auto', isPlaylist: false, sampleRate: 48000, autoCreateZip: false, title: 'Me at the zoo', artist: 'jawed' });
if (yt?.id) out.push({ plat: 'youtube', item: 'Me at the zoo', jobs: await poll([yt.id], 'yt') });

console.log('\n================ RESULTS ================');
for (const r of out) {
  for (const j of r.jobs) {
    console.log(`${r.plat.padEnd(9)} | ${(r.item || '').slice(0, 30).padEnd(30)} | ${j.status.padEnd(10)} | ${(j.error || '').slice(0, 110)} | ${j.path || ''}`);
  }
}
