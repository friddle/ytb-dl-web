import { notificationManager } from './NotificationManager.js';

// Platforms shown in the 平台状态 tab strip (first module of the home page).
const PLAT_ORDER = ['bilibili', 'qqmusic', 'netease', 'youtube', 'spotify'];
// Platforms available in aggregated search (Spotify has no cookie search API).
const SEARCHABLE = ['qqmusic', 'netease', 'bilibili', 'youtube'];
// Platforms that never need a login for search.
const LOGIN_FREE_SEARCH = ['qqmusic', 'netease'];

const PLAT_ICONS = {
  bilibili: '📺', qqmusic: '🐧', netease: '🎵', youtube: '▶️', spotify: '🎧'
};

export class HomeApp {
  constructor() {
    this.config = null;              // /api/media/config payload
    this.status = {};                // platform → {loggedIn, vip, vipLabel, uname, source}
    this.activePlat = 'bilibili';
    this.checking = {};              // platform → true while its probe runs
    this.results = [];               // aggregated search results
    this.formats = [];
    this.searching = false;
    this.submitting = false;
  }

  initialize() {
    this.cacheElements();
    this.bindStatic();
    this.loadConfig();
    document.addEventListener('i18n:applied', () => this.rerender());
  }

  cacheElements() {
    // Platform status
    this.platTabsEl = document.getElementById('platTabs');
    this.platPanelEl = document.getElementById('platPanel');
    // Search
    this.searchPlatformsEl = document.getElementById('searchPlatforms');
    this.searchTypeSelect = document.getElementById('searchTypeSelect');
    this.searchInput = document.getElementById('searchInput');
    this.searchBtn = document.getElementById('searchBtn');
    this.resultsWrap = document.getElementById('searchResultsWrap');
    this.resultsList = document.getElementById('searchResultsList');
    this.resultsMeta = document.getElementById('searchMeta');
    this.selectAll = document.getElementById('searchSelectAll');
    this.downloadBtn = document.getElementById('downloadSelectedBtn');
    // Download options + progress queue
    this.dlOptsRow = document.getElementById('dlOptsRow');
    this.dlBasePath = document.getElementById('dlBasePath');
    this.dlSubdirInput = document.getElementById('dlSubdirInput');
    this.downloadQueueEl = document.getElementById('downloadQueue');
    this.downloadQueueList = document.getElementById('downloadQueueList');
    this.downloadQueueSummary = document.getElementById('downloadQueueSummary');
    // Download settings (live inside the settings page)
    this.convertCheckbox = document.getElementById('convertAfterCheckbox');
    this.formatSelect = document.getElementById('dlFormatSelect');
    this.bitrateSelect = document.getElementById('dlBitrateSelect');
    this.formatGroup = document.getElementById('dlFormatGroup');
    this.bitrateGroup = document.getElementById('dlBitrateGroup');
    // Top tabs / views
    this.topTabsEl = document.getElementById('topTabs');
    // Settings page
    this.settingsPage = document.getElementById('settingsPage');
    this.settingsBundledCheckbox = document.getElementById('settingsBundledCheckbox');
    this.settingsBundledNote = document.getElementById('settingsBundledNote');
    this.settingsRemoteUrlInput = document.getElementById('settingsRemoteUrlInput');
    this.settingsExternalUrlInput = document.getElementById('settingsExternalUrlInput');
    this.settingsInternalUrlInput = document.getElementById('settingsInternalUrlInput');
    this.settingsDownloadDirInput = document.getElementById('settingsDownloadDirInput');
    this.settingsVersionText = document.getElementById('settingsVersionText');
  }

  bindStatic() {
    this.searchBtn?.addEventListener('click', () => this.runSearch());
    this.searchInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.runSearch(); });
    document.getElementById('openDetailedSettingsBtn')?.addEventListener('click', () => this.showView('settings'));
    this.selectAll?.addEventListener('change', () => {
      this.resultsList?.querySelectorAll('.media-item-check').forEach((c) => { c.checked = this.selectAll.checked; });
      this.updateSelectedCount();
    });
    this.downloadBtn?.addEventListener('click', () => this.downloadSelected());
    this.convertCheckbox?.addEventListener('change', () => { this.syncConvertUi(); this.persistDlPrefs(); });
    this.formatSelect?.addEventListener('change', () => { this.syncBitrateOptions(); this.persistDlPrefs(); });
    this.bitrateSelect?.addEventListener('change', () => this.persistDlPrefs());

    // Top tabs: 首页 / 上传 / Disc / 设置 (YTLive is a plain link)
    this.topTabsEl?.querySelectorAll('.top-tab[data-view]').forEach((tab) => {
      tab.addEventListener('click', () => this.showView(tab.dataset.view));
    });
    document.getElementById('settingsBackBtn')?.addEventListener('click', () => this.showView('home'));
    document.getElementById('settingsSaveBtn')?.addEventListener('click', () => this.saveSettings());
    this.settingsBundledCheckbox?.addEventListener('change', () => this.syncSettingsLockUi());

    document.getElementById('chromeBrowserOpenBtn')?.addEventListener('click', () => {
      window.open(this.browserBase(), '_blank', 'noopener,noreferrer');
    });

    this.bindThemeToggle();
  }

  bindThemeToggle() {
    const themeToggle = document.getElementById('themeToggle');
    if (!themeToggle) return;
    themeToggle.addEventListener('click', () => {
      document.documentElement.classList.add('no-transition');
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      const meta = document.querySelector('meta[name="color-scheme"]');
      if (meta) meta.content = next;
      setTimeout(() => document.documentElement.classList.remove('no-transition'), 2);
      themeToggle.classList.add('switching');
      setTimeout(() => themeToggle.classList.remove('switching'), 400);
    });
  }

  // ------------------------------------------------------------------
  // i18n / notifications
  // ------------------------------------------------------------------

  tt(key, fallback) {
    const v = window.i18n && typeof window.i18n.t === 'function' ? window.i18n.t(key) : null;
    return v && v !== key ? v : (fallback ?? '');
  }

  notify(message, type = 'info') {
    notificationManager.showNotification(message, type, 'home', 3000);
  }

  rerender() {
    this.renderPlatTabs();
    this.renderPlatPanel();
    this.renderSearchPlatforms();
    this.renderResults();
  }

  // ------------------------------------------------------------------
  // Config load → initial render → ONE automatic status check
  // ------------------------------------------------------------------

  async loadConfig() {
    try {
      const r = await fetch('/api/media/config');
      this.config = await r.json();
    } catch {
      this.config = {};
    }
    // Seed status from the cookie snapshot so the page renders instantly.
    this.status = { ...(this.config?.platforms || {}) };
    if (this.dlBasePath) this.dlBasePath.textContent = this.config?.downloadDir || '/';
    this.renderPlatTabs();
    this.renderPlatPanel();
    this.renderSearchPlatforms();
    await this.loadFormats(); // populates selects + applies saved prefs
    this.fillSettings();
    // The one automatic login/VIP check on page load (server-side 45s cache).
    this.refreshAllStatuses();
  }

  // ------------------------------------------------------------------
  // Module 1: platform status (auto check once + per-platform 检测)
  // ------------------------------------------------------------------

  async refreshAllStatuses() {
    try {
      const r = await fetch('/api/media/login-status');
      const d = await r.json();
      if (d?.platforms) {
        this.status = d.platforms;
        this.renderPlatTabs();
        this.renderPlatPanel();
      }
    } catch { /* keep the cookie snapshot */ }
  }

  // Per-channel button: one-shot login + VIP check for THIS platform only.
  async checkPlatform(platform) {
    if (this.checking[platform]) return;
    this.checking[platform] = true;
    this.renderPlatTabs();
    this.renderPlatPanel();
    try {
      const r = await fetch(`/api/media/login-status?platform=${encodeURIComponent(platform)}&refresh=1`);
      const d = await r.json();
      const info = d?.platforms?.[platform];
      if (info) {
        this.status = { ...this.status, [platform]: info };
        const state = info.loggedIn ? '✅' : '⚠️';
        this.notify(`${this.platLabel(platform)} ${state} ${info.loggedIn ? this.tt('media.loggedIn', '已登录') : this.tt('media.notLoggedIn', '未登录')}${info.vip ? ' 👑 ' + (info.vipLabel || this.tt('media.vip', 'VIP')) : ''}`, info.loggedIn ? 'success' : 'warning');
      }
    } catch {
      this.notify(`${this.platLabel(platform)}: ${this.tt('home.checkFailed', '检测失败')}`, 'error');
    } finally {
      this.checking[platform] = false;
      this.renderPlatTabs();
      this.renderPlatPanel();
    }
  }

  platLabel(key) {
    return this.tt(`media.plat${key.charAt(0).toUpperCase()}${key.slice(1)}`, PLAT_ICONS[key] ? `${PLAT_ICONS[key]} ${key}` : key);
  }

  renderPlatTabs() {
    if (!this.platTabsEl) return;
    this.platTabsEl.innerHTML = '';
    for (const key of PLAT_ORDER) {
      const info = this.status?.[key] || {};
      const dot = this.checking[key] ? 'checking' : (info.loggedIn ? 'on' : 'off');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'plat-tab' + (key === this.activePlat ? ' active' : '');
      btn.setAttribute('role', 'tab');
      btn.innerHTML = `
        <span class="plat-tab__icon">${PLAT_ICONS[key] || ''}</span>
        <span class="plat-tab__name"></span>
        <span class="plat-dot ${dot}" aria-hidden="true"></span>`;
      btn.querySelector('.plat-tab__name').textContent = this.platLabel(key).replace(/^[^A-Za-z\u4e00-\u9fa5]+/, '') || key;
      btn.addEventListener('click', () => {
        this.activePlat = key;
        this.renderPlatTabs();
        this.renderPlatPanel();
      });
      this.platTabsEl.appendChild(btn);
    }
  }

  renderPlatPanel() {
    if (!this.platPanelEl) return;
    const key = this.activePlat;
    const info = this.status?.[key] || {};
    const loggedIn = !!info.loggedIn;
    const checking = !!this.checking[key];
    const badge = checking
      ? `<span class="media-login-badge" style="background:rgba(128,128,128,.2);color:var(--text-muted,gray);">⏳ ${this.tt('home.checking', '检测中…')}</span>`
      : `<span class="media-login-badge" style="background:${loggedIn ? 'rgba(46,160,67,.18)' : 'rgba(241,76,12,.18)'};color:${loggedIn ? '#2ea043' : '#f14c0c'};">${loggedIn ? this.tt('media.loggedIn', '✅ 已登录') : this.tt('media.notLoggedIn', '⚠️ 未登录')}</span>`;
    const vipBadge = info.vip
      ? `<span class="media-vip-badge" style="font-size:.85em;padding:2px 10px;border-radius:12px;background:rgba(255,193,7,.18);color:#e3a008;">👑 ${info.vipLabel || this.tt('media.vip', 'VIP')}</span>`
      : '';
    const hint = this.tt(`media.hint${key.charAt(0).toUpperCase()}${key.slice(1)}`, '') || (key === 'spotify' ? this.tt('home.hintSpotify', '登录后可用于账户状态检测') : '');
    const uname = info.uname ? `<span class="comment">👤 ${info.uname}</span>` : '';

    this.platPanelEl.innerHTML = `
      <div class="plat-panel__row">
        <span class="plat-panel__icon">${PLAT_ICONS[key] || ''}</span>
        <span class="plat-panel__name"></span>
        ${badge}
        ${vipBadge}
        ${uname}
      </div>
      <div class="plat-panel__actions">
        <button type="button" class="btn-outline" id="platCheckBtn" ${checking ? 'disabled' : ''}>🔍 <span>${this.tt('home.checkBtn', '检测')}</span></button>
        <button type="button" class="btn-outline" id="platLoginBtn"><span>${this.tt('media.scanLogin', '🛩️ 扫码登录')}</span></button>
      </div>
      ${hint ? `<small class="comment plat-panel__hint"></small>` : ''}`;

    this.platPanelEl.querySelector('.plat-panel__name').textContent = this.platLabel(key);
    const hintEl = this.platPanelEl.querySelector('.plat-panel__hint');
    if (hintEl) hintEl.textContent = hint;
    this.platPanelEl.querySelector('#platCheckBtn')?.addEventListener('click', () => this.checkPlatform(key));
    this.platPanelEl.querySelector('#platLoginBtn')?.addEventListener('click', () => {
      const loginUrl = this.config?.loginUrls?.[key];
      this.openInBrowser(loginUrl);
    });
  }
  // ------------------------------------------------------------------
  // Module 2: aggregated search
  // ------------------------------------------------------------------

  renderSearchPlatforms() {
    if (!this.searchPlatformsEl) return;
    const existing = new Map(
      [...this.searchPlatformsEl.querySelectorAll('input.media-search-platform')].map((c) => [c.value, c.checked])
    );
    this.searchPlatformsEl.innerHTML = '';
    for (const key of SEARCHABLE) {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:6px;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'media-search-platform';
      cb.value = key;
      if (existing.has(key)) {
        cb.checked = existing.get(key);
      } else {
        // Default prefill: login-free platforms + platforms that are logged in.
        const loggedIn = !!this.status?.[key]?.loggedIn;
        cb.checked = LOGIN_FREE_SEARCH.includes(key) || (key === 'bilibili' && loggedIn);
      }
      const span = document.createElement('span');
      span.textContent = this.platLabel(key);
      label.append(cb, span);
      this.searchPlatformsEl.appendChild(label);
    }
  }

  async runSearch() {
    const keyword = String(this.searchInput?.value || '').trim();
    if (!keyword) { this.notify(this.tt('home.keywordRequired', '请输入搜索关键词'), 'error'); return; }
    const platforms = [...document.querySelectorAll('#searchPlatforms input.media-search-platform:checked')].map((c) => c.value);
    if (!platforms.length) { this.notify(this.tt('home.platformRequired', '请至少选择一个搜索平台'), 'error'); return; }
    const type = this.searchTypeSelect?.value === 'playlist' ? 'playlist' : 'song';

    this.searching = true;
    this.searchBtn?.setAttribute('disabled', '1');
    const merged = [];
    const failures = [];
    await Promise.all(platforms.map(async (platform) => {
      try {
        const r = await fetch(`/api/media/search?platform=${encodeURIComponent(platform)}&type=${type}&keyword=${encodeURIComponent(keyword)}&limit=20`);
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
        for (const it of d.items || []) merged.push(it);
      } catch (err) {
        if (String(err.message).includes('428') || String(err.message).includes('登录')) {
          failures.push(`${this.platLabel(platform)}: ${this.tt('home.needLogin', '需要先登录')}`);
        } else {
          failures.push(`${this.platLabel(platform)}: ${err.message}`);
        }
      }
    }));
    this.searching = false;
    this.searchBtn?.removeAttribute('disabled');

    if (type === 'playlist') {
      const skipped = platforms.filter((p) => p === 'bilibili' || p === 'youtube');
      if (skipped.length) this.notify(`${this.tt('home.unsupportedPlaylist', '歌单搜索不支持')}: ${skipped.map((p) => this.platLabel(p)).join(', ')}`, 'info');
    }
    if (failures.length) this.notify(`${this.tt('home.partialFailed', '部分平台失败')} → ${failures.join('；')}`, 'error');

    this.results = merged;
    if (this.resultsWrap) this.resultsWrap.style.display = '';
    if (this.dlOptsRow) this.dlOptsRow.style.display = '';
    if (this.selectAll) this.selectAll.checked = merged.length > 0;
    this.resultsMeta.textContent = `${this.tt('home.total', '共')} ${merged.length} ${this.tt('home.items', '条')}`;
    this.renderResults();
    this.updateSelectedCount();
  }

  renderResults() {
    if (!this.resultsList) return;
    this.resultsList.innerHTML = '';
    this.results.forEach((item, idx) => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 10px;border:1px solid rgba(128,128,128,.2);border-radius:6px;cursor:pointer;';
      const duration = item.durationSec ? this.fmtDuration(item.durationSec) : '';
      const isPlaylist = item.type === 'playlist';
      const count = isPlaylist && item.trackCount ? ` (${item.trackCount})` : '';
      const tag = `${this.platTag(item.platform)}${isPlaylist ? ' 📃' : ''}`;
      row.innerHTML = `
        <input type="checkbox" class="media-item-check" data-idx="${idx}" checked>
        <span class="media-item-platform" style="font-size:.8em;opacity:.75;min-width:70px;">${tag}</span>
        <span class="media-item-title" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
        <span class="media-item-artist" style="font-size:.82em;opacity:.75;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
        ${duration ? `<span style="font-size:.8em;opacity:.6;">${duration}</span>` : ''}`;
      row.querySelector('.media-item-title').textContent = (item.title || '') + count;
      row.querySelector('.media-item-artist').textContent = item.artist || '';
      row.querySelector('.media-item-check').addEventListener('change', () => this.updateSelectedCount());
      this.resultsList.appendChild(row);
    });
  }

  platTag(platform) {
    return {
      bilibili: '📺 B站', qqmusic: '🐧 QQ', netease: '🎵 网易',
      youtube: '▶️ YT', spotify: '🎧 Spotify', netease_redirect: '🎵 网易'
    }[platform] || platform;
  }

  fmtDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  updateSelectedCount() {
    const n = this.resultsList?.querySelectorAll('.media-item-check:checked').length || 0;
    if (this.downloadBtn) this.downloadBtn.disabled = n === 0;
  }

  // Submits one /api/jobs job per selected item, using the settings-page
  // preferences (convert checkbox → format/bitrate; unchecked = ORIGINAL).
  // Playlist items are expanded into their tracks first so every item gets its
  // own progress row and failure reason. Optional per-download subfolder.
  async downloadSelected() {
    if (this.submitting) return;
    const checked = [...(this.resultsList?.querySelectorAll('.media-item-check:checked') || [])];
    if (!checked.length) { this.notify(this.tt('home.selectRequired', '请先勾选要下载的条目'), 'error'); return; }
    const convert = !!this.convertCheckbox?.checked;
    const format = convert ? (this.formatSelect?.value || 'mp3') : 'original';
    const bitrate = convert ? (this.bitrateSelect?.value || '320k') : 'auto';
    const rawSubdir = String(this.dlSubdirInput?.value || '').trim().replace(/^\/+|\/+$/g, '');
    const selected = checked.map((c) => this.results[Number(c.dataset.idx)]).filter(Boolean);

    this.submitting = true;
    this.downloadBtn?.setAttribute('disabled', '1');

    // Expand playlists into track lists (details visible in the queue).
    const queue = [];
    for (const item of selected) {
      if (item.type === 'playlist') {
        try {
          const r = await fetch(`/api/media/resolve?url=${encodeURIComponent(item.url)}`);
          const d = await r.json();
          if (!r.ok || !d.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
          const tracks = (d.items || []).map((t) => ({
            ...t,
            platform: item.platform,
            fromPlaylist: item.title
          }));
          this.notify(`${this.tt('home.expandPlaylists', '歌单已展开')}: ${item.title} → ${tracks.length}`, 'info');
          if (tracks.length) queue.push(...tracks);
        } catch (err) {
          queue.push({ ...item, status: 'failed', error: `${this.tt('home.expandFailed', '歌单解析失败')}: ${err.message}`, progress: 0 });
        }
      } else {
        queue.push({ ...item });
      }
    }
    if (!queue.length) {
      this.submitting = false;
      this.downloadBtn?.removeAttribute('disabled');
      return;
    }

    // Queue rows: pending → queued → processing → completed/error.
    this.queueRows = queue.map((it) => ({
      ...it,
      jobId: null,
      status: 'pending',
      progress: 0,
      error: it.error || null
    }));
    this.renderQueue();
    this.downloadQueueEl.style.display = '';
    this.downloadQueueEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    let ok = 0;
    for (const row of this.queueRows) {
      if (row.status === 'failed') continue;
      try {
        const resp = await fetch('/api/jobs', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: row.url,
            format,
            bitrate,
            isPlaylist: false,
            sampleRate: 48000,
            autoCreateZip: false,
            ...(rawSubdir ? { outputSubdir: rawSubdir } : {})
          })
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && (data.id || data.ok || data.data?.id)) {
          row.jobId = data.id || data.data?.id;
          row.status = 'queued';
          ok += 1;
        } else {
          row.status = 'failed';
          row.error = data?.error?.message || `HTTP ${resp.status}`;
        }
      } catch (err) {
        row.status = 'failed';
        row.error = err.message;
      }
      this.renderQueue();
    }
    this.submitting = false;
    this.downloadBtn?.removeAttribute('disabled');
    this.pollQueueStatuses();
  }

  // Polls the batched jobs-status endpoint until every row reaches a terminal state.
  async pollQueueStatuses() {
    if (this._queuePollTimer) clearInterval(this._queuePollTimer);
    const tick = async () => {
      const ids = (this.queueRows || []).map((r) => r.jobId).filter(Boolean);
      if (!ids.length) { clearInterval(this._queuePollTimer); this._queuePollTimer = null; return; }
      try {
        const r = await fetch(`/api/media/jobs-status?ids=${encodeURIComponent(ids.join(','))}`);
        const d = await r.json();
        const byId = new Map((d?.jobs || []).map((j) => [j.id, j]));
        let active = 0;
        for (const row of this.queueRows || []) {
          if (!row.jobId) { if (row.status !== 'failed') active += 1; continue; }
          const j = byId.get(row.jobId);
          if (!j) continue;
          row.status = j.status;
          row.progress = j.progress || 0;
          row.currentPhase = j.currentPhase;
          row.error = j.error;
          const terminal = ['completed', 'error', 'canceled', 'missing'].includes(j.status);
          if (!terminal) active += 1;
        }
        this.renderQueue();
        if (!active) { clearInterval(this._queuePollTimer); this._queuePollTimer = null; }
      } catch { /* transient network error; retry on next tick */ }
    };
    await tick();
    this._queuePollTimer = setInterval(tick, 2500);
  }

  queueStatusBadge(row) {
    const t = (k, fb) => this.tt(k, fb);
    if (row.status === 'completed') return `<span class="dq-badge ok">✅ ${t('home.jobDone', '完成')}</span>`;
    if (row.status === 'failed' || row.status === 'error' || row.status === 'missing') {
      const reason = row.error ? String(row.error).replace(/"/g, '&quot;') : '';
      return `<span class="dq-badge err" title="${reason}">❌ ${t('home.jobFailed', '失败')}</span><span class="dq-reason" title="${reason}">${reason}</span>`;
    }
    if (row.status === 'canceled') return `<span class="dq-badge err">⛔ ${t('home.jobCanceled', '已取消')}</span>`;
    if (row.status === 'processing') {
      const phase = row.currentPhase === 'convert' ? t('home.jobConverting', '转换中') : t('home.jobDownloading', '下载中');
      return `<span class="dq-badge run">⏳ ${phase} ${Math.round(row.progress || 0)}%</span>
        <span class="dq-bar"><span style="width:${Math.min(100, Math.max(2, row.progress || 0))}%"></span></span>`;
    }
    if (row.status === 'queued') return `<span class="dq-badge run">🕰️ ${t('home.jobQueued', '排队中')}</span>`;
    return `<span class="dq-badge">⋯ ${t('home.jobPending', '等待')}</span>`;
  }

  renderQueue() {
    if (!this.downloadQueueList) return;
    this.downloadQueueList.innerHTML = '';
    for (const row of this.queueRows || []) {
      const div = document.createElement('div');
      div.className = 'dq-row';
      div.innerHTML = `
        <span class="media-item-platform" style="font-size:.8em;opacity:.75;min-width:70px;">${this.platTag(row.platform)}</span>
        <span class="dq-title"></span>
        <span class="dq-artist"></span>
        ${row.durationSec ? `<span class="dq-dur">${this.fmtDuration(row.durationSec)}</span>` : ''}
        <span class="dq-status">${this.queueStatusBadge(row)}</span>`;
      div.querySelector('.dq-title').textContent = row.title || '';
      div.querySelector('.dq-artist').textContent = row.artist || '';
      this.downloadQueueList.appendChild(div);
    }
    const rows = this.queueRows || [];
    const done = rows.filter((r) => r.status === 'completed').length;
    const failed = rows.filter((r) => ['failed', 'error'].includes(r.status)).length;
    if (this.downloadQueueSummary) {
      this.downloadQueueSummary.textContent = `${done}/${rows.length}${failed ? ` • ${this.tt('home.jobFailed', '失败')} ${failed}` : ''}`;
    }
  }

  // ------------------------------------------------------------------
  // Module 3: download settings
  // ------------------------------------------------------------------

  async loadFormats() {
    try {
      const r = await fetch('/api/formats');
      const d = await r.json();
      this.formats = (d.formats || []).filter((f) => !f.hidden && f.type === 'audio');
    } catch {
      this.formats = [{ format: 'mp3', bitrates: ['320k', '192k', '128k'], defaultBitrate: '320k' }];
    }
    if (!this.formatSelect) return;
    this.formatSelect.innerHTML = '';
    for (const f of this.formats) {
      const opt = document.createElement('option');
      opt.value = f.format;
      opt.textContent = f.format.toUpperCase();
      this.formatSelect.appendChild(opt);
    }
    const preferred = this.formats.find((f) => f.format === 'mp3') || this.formats[0];
    if (preferred) this.formatSelect.value = preferred.format;
    this.restoreDlPrefs();
    this.syncBitrateOptions();
    this.syncConvertUi();
  }

  // Download preferences survive reloads via localStorage.
  persistDlPrefs() {
    try {
      localStorage.setItem('gharmonize_dl_prefs', JSON.stringify({
        convert: !!this.convertCheckbox?.checked,
        format: this.formatSelect?.value || 'mp3',
        bitrate: this.bitrateSelect?.value || '320k'
      }));
    } catch { /* private mode etc. */ }
  }

  restoreDlPrefs() {
    try {
      const raw = localStorage.getItem('gharmonize_dl_prefs');
      if (!raw) return;
      const prefs = JSON.parse(raw);
      if (this.convertCheckbox) this.convertCheckbox.checked = prefs.convert !== false;
      if (prefs.format && this.formatSelect?.querySelector(`option[value="${CSS.escape(prefs.format)}"]`)) {
        this.formatSelect.value = prefs.format;
      }
      if (prefs.bitrate) this._pendingBitrate = prefs.bitrate;
    } catch { /* ignore malformed prefs */ }
  }

  syncBitrateOptions() {
    const fmt = this.formats.find((f) => f.format === this.formatSelect?.value);
    if (!this.bitrateSelect || !fmt) return;
    this.bitrateSelect.innerHTML = '';
    for (const br of fmt.bitrates || ['auto']) {
      const opt = document.createElement('option');
      opt.value = br;
      opt.textContent = br === 'lossless' ? this.tt('home.lossless', '无损') : br;
      this.bitrateSelect.appendChild(opt);
    }
    const wanted = this._pendingBitrate;
    const options = [...this.bitrateSelect.options].map((o) => o.value);
    if (wanted && options.includes(wanted)) {
      this.bitrateSelect.value = wanted;
    } else {
      this.bitrateSelect.value = fmt.defaultBitrate || (fmt.bitrates || ['auto'])[0];
    }
    this._pendingBitrate = null;
  }

  syncConvertUi() {
    const on = !!this.convertCheckbox?.checked;
    if (this.formatGroup) this.formatGroup.style.display = on ? '' : 'none';
    if (this.bitrateGroup) this.bitrateGroup.style.display = on ? '' : 'none';
  }

  // ------------------------------------------------------------------
  // Browser helpers — login/players ALWAYS open a new browser tab.
  // ------------------------------------------------------------------

  browserBase() {
    return this.config?.browserExternalUrl
      || this.config?.browserInternalUrl
      || `${location.protocol}//${location.hostname}:9203/`;
  }

  openInBrowser(targetUrl) {
    const base = this.browserBase();
    const url = targetUrl
      ? `${base}${base.includes('?') ? '&' : '?'}url=${encodeURIComponent(targetUrl)}`
      : base;
    window.open(url, '_blank', 'noopener,noreferrer');
    return url;
  }

  // ------------------------------------------------------------------
  // Views: home / upload / disc / settings (top tabs)
  // ------------------------------------------------------------------

  showView(view) {
    const views = { home: 'homeMain', upload: 'uploadView', disc: 'discView', settings: 'settingsPage' };
    for (const [name, id] of Object.entries(views)) {
      const el = document.getElementById(id);
      if (el) el.hidden = name !== view;
    }
    this.topTabsEl?.querySelectorAll('.top-tab[data-view]').forEach((tab) => {
      const active = tab.dataset.view === view;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (view === 'settings') this.fillSettings();
    window.scrollTo({ top: 0 });
  }

  fillSettings() {
    const bundled = !!this.config?.browserBundled;
    if (this.settingsBundledCheckbox) {
      this.settingsBundledCheckbox.checked = bundled;
      this.settingsBundledCheckbox.disabled = bundled;
    }
    if (this.settingsBundledNote) this.settingsBundledNote.style.display = bundled ? '' : 'none';
    if (this.settingsRemoteUrlInput && document.activeElement !== this.settingsRemoteUrlInput) {
      this.settingsRemoteUrlInput.value = this.config?.browserUrl || '';
    }
    if (this.settingsExternalUrlInput && document.activeElement !== this.settingsExternalUrlInput) {
      this.settingsExternalUrlInput.value = this.config?.browserExternalUrl || '';
    }
    if (this.settingsInternalUrlInput && document.activeElement !== this.settingsInternalUrlInput) {
      this.settingsInternalUrlInput.value = this.config?.browserInternalUrl || '';
    }
    if (this.settingsDownloadDirInput && document.activeElement !== this.settingsDownloadDirInput) {
      this.settingsDownloadDirInput.value = this.config?.downloadDir || '';
    }
    const ver = window.versionManager?.currentVersion;
    if (this.settingsVersionText && ver) this.settingsVersionText.textContent = `v${ver}`;
    this.syncSettingsLockUi();
  }

  syncSettingsLockUi() {
    const bundled = !!this.config?.browserBundled;
    const useBundled = this.settingsBundledCheckbox?.checked || bundled;
    for (const el of [this.settingsRemoteUrlInput, this.settingsExternalUrlInput, this.settingsInternalUrlInput]) {
      if (el) el.disabled = useBundled;
    }
  }

  async saveSettings() {
    const btn = document.getElementById('settingsSaveBtn');
    const updates = {};
    const dir = String(this.settingsDownloadDirInput?.value || '').trim();
    updates.MEDIA_DOWNLOAD_DIR = dir;
    if (!this.config?.browserBundled && !this.settingsBundledCheckbox?.checked) {
      updates.CHROME_DRIVERLESS_URL = String(this.settingsRemoteUrlInput?.value || '').trim();
      updates.CHROME_DRIVERLESS_EXTERNAL_URL = String(this.settingsExternalUrlInput?.value || '').trim();
      updates.CHROME_DRIVERLESS_INTERNAL_URL = String(this.settingsInternalUrlInput?.value || '').trim();
    }
    if (btn) { btn.setAttribute('disabled', '1'); }
    try {
      const resp = await fetch('/api/settings', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: updates })
      });
      if (resp.status === 401 || resp.status === 403) {
        this.notify(this.tt('settings.loginRequired', '保存需要管理员登录'), 'error');
        window.settingsManager?.openLoginOnly?.();
        return;
      }
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(d?.error?.message || `HTTP ${resp.status}`);
      this.notify(this.tt('settings.saved', '设置已保存'), 'success');
      await this.loadConfig();
    } catch (err) {
      this.notify(`${this.tt('settings.saveFailed', '保存失败')}: ${err.message}`, 'error');
    } finally {
      if (btn) btn.removeAttribute('disabled');
    }
  }
}

export default HomeApp;
