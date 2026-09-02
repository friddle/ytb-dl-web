// Checks every platform's live login + VIP status through the deployment's
// own /api/media/login-status endpoint (which runs the in-browser probes).
//
// Usage:  node scripts/nas-login-status.mjs [baseUrl]
//   baseUrl defaults to http://127.0.0.1:5174
const BASE = (process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:5174').replace(/\/+$/, '');

const r = await fetch(`${BASE}/api/media/login-status?refresh=1`, { signal: AbortSignal.timeout(120000) });
const d = await r.json();
if (!d?.ok) {
  console.error('login-status failed:', JSON.stringify(d).slice(0, 300));
  process.exit(1);
}

const ICONS = { bilibili: '📺', qqmusic: '🐧', netease: '🎵', youtube: '▶️', spotify: '🎧' };
console.log(`platform    login  vip    uname          source     note`);
for (const [p, i] of Object.entries(d.platforms)) {
  const icon = ICONS[p] || '  ';
  const login = i.loggedIn ? 'yes' : 'NO';
  const vip = i.vip ? `yes (${i.vipLabel || 'vip'})` : 'no';
  const uname = (i.uname || '-').slice(0, 14).padEnd(14);
  const note = i.error ? `error: ${i.error}` : (i.source === 'cookies' ? 'cookie snapshot only' : '');
  console.log(`${icon} ${p.padEnd(9)} ${login.padEnd(6)} ${vip.padEnd(20)} ${uname} ${(i.source || '').padEnd(9)} ${note}`);
}
