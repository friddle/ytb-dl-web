import { notificationManager } from './NotificationManager.js';
import { startDiscProgressStream, stopDiscProgressStream } from './discRipperPanel.js';

// Platforms shown in the 平台状态 tab strip (first module of the home page).
const PLAT_ORDER = ['bilibili', 'qqmusic', 'netease', 'youtube', 'spotify'];
// Platforms available in aggregated search (Spotify via Web API: app creds or
// the logged-in sp_dc cookie).
const SEARCHABLE = ['qqmusic', 'netease', 'spotify', 'bilibili', 'youtube'];
// Platforms that never need a login for search.
const LOGIN_FREE_SEARCH = ['qqmusic', 'netease'];

const PLAT_ICONS = {
  bilibili: '📺', qqmusic: '🐧', netease: '🎵', youtube: '▶️', spotify: '🎧'
};

export class HomeApp {
  // Visible views; each maps to location.hash (e.g. #/search) so any tab is
  // directly linkable/shareable. Legacy routes (parse/upload/log) redirect.
  static VIEWS = { home: 'homeMain', search: 'searchView', download: 'downloadView', upload: 'uploadView', disc: 'discView', settings: 'settingsPage' };
  static ROUTE_ALIASES = { parse: 'search', online: 'search', log: 'settings' };

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
    this.hydrateQueueFromDb();
    document.addEventListener('i18n:applied', () => this.rerender());
    // Hash routing: deep-linkable tabs + back/forward support.
    window.addEventListener('hashchange', () => this.applyRoute());
    this.applyRoute();
  }

  // Restores the download queue after a page refresh: the SQLite jobs table
  // keeps every task's status/progress/error. In-memory rows (fresh submits
  // from this session) always win over their stale DB twins.
  async hydrateQueueFromDb() {
    try {
      const r = await fetch('/api/media/jobs-recent?limit=300');
      const d = await r.json();
      const rows = Array.isArray(d?.jobs) ? d.jobs : [];
      if (!rows.length) return;
      const known = new Set((this.queueRows || []).map((x) => x.jobId || x.id));
      const restored = rows
        .filter((j) => !known.has(j.id) && !this.hiddenJobIds.has(j.id))
        .reverse() // oldest first so the list reads in submit order
        .map((j) => ({
          jobId: j.id,
          url: j.url || '',
          platform: j.platform || '',
          title: j.title || '',
          artist: j.artist || '',
          album: j.album || '',
          format: j.format || 'original',
          bitrate: j.bitrate || 'auto',
          outputSubdir: j.outputSubdir || null,
          rename: j.rename || null,
          status: j.status === 'processing' ? 'processing' : (j.status || 'queued'),
          progress: Number(j.progress) || 0,
          currentPhase: j.current_phase || null,
          error: j.error || null,
          fromDb: true
        }));
      if (!restored.length) return;
      this.queueRows = [...restored, ...(this.queueRows || [])];
      this.renderQueue();
      if (this.downloadQueueEl) this.downloadQueueEl.style.display = '';
      if (restored.some((x) => !['completed', 'error', 'canceled', 'missing'].includes(x.status))) {
        this.pollQueueStatuses();
      }
    } catch { /* transient */ }
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
    this.downloadQueueEl = document.getElementById('downloadQueue');
    this.downloadQueueList = document.getElementById('downloadQueueList');
    this.downloadQueueSummary = document.getElementById('downloadQueueSummary');
    // Download module sub-tabs (status / config / library) + status filter
    this.dlSubTabsEl = document.getElementById('dlSubTabs');
    this.dlStatusPane = document.getElementById('dlStatusPane');
    this.dlConfigPane = document.getElementById('dlConfigPane');
    this.dlLibraryPane = document.getElementById('dlLibraryPane');
    this.dlLibraryList = document.getElementById('dlLibraryList');
    this.dlLibraryEmpty = document.getElementById('dlLibraryEmpty');
    this.dlStatusFilterEl = document.getElementById('dlStatusFilter');
    this.dlStatusFilter = 'all';
    this.dlTab = 'status';
    // Per-scope download config: songs and playlists are configured separately.
    this.dlCfg = { song: { format: 'default', bitrate: 'auto', subdir: '', rename: '' }, playlist: { format: 'default', bitrate: 'auto', subdir: '', rename: '' } };
    this.cfgSongFormatSelect = document.getElementById('dlSongFormatSelect');
    this.cfgSongBitrateSelect = document.getElementById('dlSongBitrateSelect');
    this.cfgSongSubdirInput = document.getElementById('dlSongSubdirInput');
    this.cfgSongRenameInput = document.getElementById('dlSongRenameInput');
    this.cfgListFormatSelect = document.getElementById('dlListFormatSelect');
    this.cfgListBitrateSelect = document.getElementById('dlListBitrateSelect');
    this.cfgListSubdirInput = document.getElementById('dlListSubdirInput');
    this.cfgListRenameInput = document.getElementById('dlListRenameInput');
    // Download settings templates (format/bitrate/subdir/rename presets).
    this.tplSelect = document.getElementById('dlTplSelect');
    this.tplApplyBtn = document.getElementById('dlTplApplyBtn');
    this.tplSaveBtn = document.getElementById('dlTplSaveBtn');
    this.tplDeleteBtn = document.getElementById('dlTplDeleteBtn');
    // Display-only dismissal of finished queue rows (never deletes data).
    this.hiddenJobIds = new Set(this.readJson('gharmonize_dq_hidden', []));
    this.clearDoneBtn = document.getElementById('clearDoneBtn');
    // Queue list pagination (50 rows per page).
    this.queuePage = 1;
    this.queuePageSize = 50;
    this.dqPager = document.getElementById('dqPager');
    this.dqPageInfo = document.getElementById('dqPageInfo');
    document.getElementById('dqPrevBtn')?.addEventListener('click', () => { this.queuePage = Math.max(1, this.queuePage - 1); this.renderQueue(); });
    document.getElementById('dqNextBtn')?.addEventListener('click', () => { this.queuePage += 1; this.renderQueue(); });
    // Download settings (live inside the settings page)
    this.convertCheckbox = document.getElementById('convertAfterCheckbox');
    this.formatSelect = document.getElementById('dlFormatSelect');
    this.bitrateSelect = document.getElementById('dlBitrateSelect');
    this.formatGroup = document.getElementById('dlFormatGroup');
    this.bitrateGroup = document.getElementById('dlBitrateGroup');
    // Top tabs / views
    this.topTabsEl = document.getElementById('topTabs');
    // Language icon button (cycles languages)
    this.langIconBtn = document.getElementById('langIconBtn');
    // Search view (includes the link-parse hero card)
    this.searchViewEl = document.getElementById('searchView');
    // Parse (inside search view)
    this.parseModeSelect = document.getElementById('parseModeSelect');
    this.parseUrlInput = document.getElementById('parseUrlInput');
    this.parseBtn = document.getElementById('parseBtn');
    this.parseResultsWrap = document.getElementById('parseResultsWrap');
    this.parseMeta = document.getElementById('parseMeta');
    this.parseResultsList = document.getElementById('parseResultsList');
    this.parseDownloadBtn = document.getElementById('parseDownloadBtn');
    this.parsedItems = [];
    // Download view
    this.downloadViewEl = document.getElementById('downloadView');
    this.dlToolsLine = document.getElementById('dlToolsLine');
    this.dlToolsText = document.getElementById('dlToolsText');
    // Upload tools (inside download view)
    this.uploadToolsLine = document.getElementById('uploadToolsLine');
    this.uploadToolsText = document.getElementById('uploadToolsText');
    // Log box (inside settings view)
    this.logLinesBox = document.getElementById('logLinesBox');
    this.logRefreshBtn = document.getElementById('logRefreshBtn');
    this._logTimer = null;
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
    document.getElementById('retryFailedBtn')?.addEventListener('click', () => this.retryFailed());
    // One-shot live check for every platform (sequential, server caches 45s).
    document.getElementById('checkAllBtn')?.addEventListener('click', async () => {
      const btn = document.getElementById('checkAllBtn');
      if (btn?.dataset.busy) return;
      if (btn) btn.dataset.busy = '1';
      for (const key of PLAT_ORDER) {
        await this.checkPlatform(key);
      }
      if (btn) delete btn.dataset.busy;
    });
    this.selectAll?.addEventListener('change', () => {
      this.resultsList?.querySelectorAll('.media-item-check').forEach((c) => { c.checked = this.selectAll.checked; });
      this.resultsList?.querySelectorAll('.media-group-check').forEach((c) => { c.checked = this.selectAll.checked; c.indeterminate = false; this.onPlaylistMasterToggle(Number(c.dataset.idx)); });
      this.updateSelectedCount();
    });    this.downloadBtn?.addEventListener('click', () => this.downloadSelected());
    this.clearDoneBtn?.addEventListener('click', () => this.clearFinishedRows());
    this.tplApplyBtn?.addEventListener('click', () => this.applyTemplate());
    this.tplSaveBtn?.addEventListener('click', () => this.saveTemplateFromCurrent());
    this.tplDeleteBtn?.addEventListener('click', () => this.deleteTemplate());
    this.convertCheckbox?.addEventListener('change', () => { this.syncConvertUi(); this.persistDlPrefs(); });
    this.formatSelect?.addEventListener('change', () => { this.syncBitrateOptions(); this.persistDlPrefs(); });
    this.bitrateSelect?.addEventListener('change', () => this.persistDlPrefs());

    // Download module: status/config sub-tabs + status filter chips.
    this.dlSubTabsEl?.querySelectorAll('.dl-subtab[data-dltab]').forEach((tab) => {
      tab.addEventListener('click', () => this.setDlTab(tab.dataset.dltab));
    });
    this.dlStatusFilterEl?.querySelectorAll('.dl-filter-chip[data-filter]').forEach((chip) => {
      chip.addEventListener('click', () => {
        this.dlStatusFilter = chip.dataset.filter || 'all';
        this.dlStatusFilterEl.querySelectorAll('.dl-filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
        this.renderQueue();
      });
    });
    // Per-scope config persistence.
    const cfgBind = [this.cfgSongFormatSelect, this.cfgListFormatSelect];
    cfgBind.forEach((sel) => sel?.addEventListener('change', () => { this.syncScopeBitrates(); this.persistScopeCfg(); }));
    [this.cfgSongBitrateSelect, this.cfgListBitrateSelect, this.cfgSongSubdirInput, this.cfgListSubdirInput].forEach((el) => {
      el?.addEventListener('change', () => this.persistScopeCfg());
    });

    // Top tabs: routes live in location.hash (YTLive is a plain link).
    this.topTabsEl?.querySelectorAll('.top-tab[data-view]').forEach((tab) => {
      tab.addEventListener('click', () => {
        if (tab.dataset.view === 'browser') { this.openBrowserTab(); return; }
        this.showView(tab.dataset.view);
      });
    });
    // "去设置调整" hint buttons on HOME / SEARCH / DOWNLOAD
    document.querySelectorAll('[data-open-settings]').forEach((btn) => btn.addEventListener('click', () => this.showView('settings')));
    // Language icon cycles languages
    this.langIconBtn?.addEventListener('click', () => {
      const order = ['zh', 'en', 'tr', 'es', 'de', 'fr'];
      const current = window.i18n?.lang || 'zh';
      const next = order[(order.indexOf(current) + 1) % order.length] || 'zh';
      window.i18n?.setLang?.(next);
    });
    document.getElementById('settingsSaveBtn')?.addEventListener('click', () => this.saveSettings());
    this.settingsBundledCheckbox?.addEventListener('change', () => this.syncSettingsLockUi());

    // PARSE view
    this.parseBtn?.addEventListener('click', () => this.resolveParse());
    this.parseUrlInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.resolveParse(); });
    this.parseDownloadBtn?.addEventListener('click', () => this.downloadParsed());
    // LOG view
    this.logRefreshBtn?.addEventListener('click', () => this.loadLogs());
    // Mini preview player close button
    document.querySelector('.mini-player__close')?.addEventListener('click', () => this.closePreview());

    document.getElementById('chromeBrowserOpenBtn')?.addEventListener('click', () => {
      window.open(this.browserBase(), '_blank', 'noopener,noreferrer');
    });
  }

  // Theme toggling is handled by MediaConverterApp.initializeTheme — binding
  // it here too would flip the theme twice per click (net zero change).

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
        <button type="button" class="btn-outline" id="platLoginBtn"><span>${this.tt('media.scanLogin', '登录')}</span></button>
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
      label.className = 'plat-check';
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
      const icon = document.createElement('span');
      icon.className = 'plat-check__icon';
      icon.textContent = PLAT_ICONS[key] || '';
      const name = document.createElement('span');
      name.className = 'plat-check__name';
      name.textContent = this.platLabel(key).replace(/^[^A-Za-z\u4e00-\u9fa5]+/, '') || key;
      label.append(cb, icon, name);
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
    // Nothing is preselected — the user picks what to download.
    if (this.selectAll) this.selectAll.checked = false;
    this.resultsMeta.textContent = `${this.tt('home.total', '共')} ${merged.length} ${this.tt('home.items', '条')}`;
    this.renderResults();
    this.updateSelectedCount();
  }

  // Builds a rich row for any search/parse item. Song rows: label + checkbox +
  // preview button. Playlist rows: a .media-group master checkbox (checked =
  // select all tracks, the default) + expandable detail (点击展开 → per-track
  // checkboxes + preview), rendered by renderPlaylistChildren.
  buildMediaRow(item, idx, opts = {}) {
    const trackOf = opts.trackOf ?? null; // set → this row is a track inside that playlist idx
    const isTopPlaylist = trackOf === null && item.type === 'playlist';
    const row = document.createElement(isTopPlaylist ? 'div' : 'label');
    row.className = 'media-row' + (isTopPlaylist ? ' is-playlist' : '');
    const isPlaylist = item.type === 'playlist';
    const duration = item.durationSec ? this.fmtDuration(item.durationSec) : '';
    const count = isPlaylist && item.trackCount ? ` (${item.trackCount})` : '';
    const tag = `${this.platTag(item.platform)}${isPlaylist ? ' 📃' : ''}`;
    const checkClass = trackOf !== null ? 'media-track-check' : (isPlaylist ? 'media-group-check' : 'media-item-check');
    const chips = [];
    if (item.fileFormat) chips.push(`<span class="media-chip fmt">${item.fileFormat}${item.quality ? ' · ' + item.quality : ''}</span>`);
    if (item.vip) chips.push(`<span class="media-chip vip">👑 ${this.tt('home.vipRequired', 'VIP')}</span>`);
    // Account-aware warning (orange): the download is likely to fail when the
    // source platform is not logged in, or the song is VIP-only and the
    // logged-in account has no VIP tier.
    const acct = this.status?.[item.platform] || {};
    let warn = '';
    if (!isPlaylist && !acct.loggedIn) {
      warn = `<span class="media-warn" title="${this.tt('media.notLoggedIn', '未登录')}">${this.tt('home.tagNoLogin', '未登录')}</span>`;
    } else if (!isPlaylist && item.vip && !acct.vip) {
      warn = `<span class="media-warn" title="${this.tt('home.vipTip', '当前账号非会员，可能无法下载')}">${this.tt('home.tagVip', '需VIP')}</span>`;
    }
    const creatorLabel = { singer: 'creator.singer', uploader: 'creator.uploader', channel: 'creator.channel', composer: 'creator.composer', lyricist: 'creator.lyricist' };
    for (const [k, v] of Object.entries(item.creators || {})) {
      if (!v) continue;
      chips.push(`<span class="media-chip creator">${this.tt(creatorLabel[k] || 'creator.uploader', k)}: </span>`);
    }
    if (item.album) chips.push(`<span class="media-chip album">${this.tt('home.album', '专辑')}: </span>`);
    if (item.stats?.plays) chips.push(`<span class="media-chip plays">▶ ${item.stats.plays >= 10000 ? Math.round(item.stats.plays / 10000) + 'w' : item.stats.plays}</span>`);
    row.innerHTML = `
      <input type="checkbox" class="${checkClass}" data-idx="${idx}" ${trackOf !== null ? `data-parent="${trackOf}"` : ''} ${isTopPlaylist ? 'checked' : ''}>
      <button type="button" class="media-cfg" data-idx="${idx}" title="${this.tt('home.rowCfgTitle', '此条目下载设置')}">⚙</button>
      ${isTopPlaylist ? `<button type="button" class="media-expand" aria-label="${this.tt('home.plDetail', '展开歌单')}"><span class="media-expand-arrow">▸</span></button>` : ''}
      <span class="media-row-cover">${item.cover ? `<img src="${item.cover}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '🎵'}</span>
      <span class="media-row-body">
        <span class="media-row-main">
          <span class="media-item-platform">${tag}</span>
          <span class="media-item-title"></span>
          ${warn}
          ${duration ? `<span class="media-item-dur">${duration}</span>` : ''}
        </span>
        ${chips.length ? `<span class="media-row-meta">${chips.join('')}</span>` : ''}
        ${item.description ? '<span class="media-row-desc"></span>' : ''}
      </span>
      ${!isPlaylist || trackOf !== null ? `<button type="button" class="media-play" title="${this.tt('home.preview', '试听')}">▶</button>` : ''}`;
    row.querySelector('.media-item-title').textContent = (item.title || '') + count;
    // Fill text content for creator/album/description chips (XSS-safe).
    const chipsEls = row.querySelectorAll('.media-chip.creator, .media-chip.album');
    let ci = 0;
    for (const [k, v] of Object.entries(item.creators || {})) {
      if (!v) continue;
      const el = chipsEls[ci++];
      if (el) el.append(document.createTextNode(String(v)));
    }
    if (item.album && chipsEls[ci]) chipsEls[ci++].append(document.createTextNode(String(item.album)));
    const descEl = row.querySelector('.media-row-desc');
    if (descEl) descEl.textContent = item.description || '';
    if (trackOf !== null) {
      row.querySelector('.media-track-check').addEventListener('change', () => this.syncPlaylistMaster(trackOf));
    } else if (isTopPlaylist) {
      row.querySelector('.media-group-check').addEventListener('change', () => this.onPlaylistMasterToggle(idx));
    } else {
      row.querySelector('.media-item-check').addEventListener('change', () => this.updateSelectedCount());
    }
    // ⚙ per-item download settings (format/subdir/rename override).
    row.querySelector('.media-cfg')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openRowCfgDialog(idx, isTopPlaylist);
    });
    // Preview button: stop the label's default checkbox toggle.
    row.querySelector('.media-play')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.playPreview(item, e.currentTarget);
    });
    // Playlist rows: clicking the body or the arrow toggles the detail section.
    if (isTopPlaylist) {
      const body = row.querySelector('.media-row-body');
      body.style.cursor = 'pointer';
      body.addEventListener('click', (e) => { e.preventDefault(); this.togglePlaylistDetail(idx); });
      row.querySelector('.media-expand').addEventListener('click', (e) => { e.preventDefault(); this.togglePlaylistDetail(idx); });
    }
    return row;
  }

  // --------------------------------------------------------------
  // Playlist (工单) detail: lazy-loaded track list. Master checkbox =
  // select all (默认全选), per-track re-check, per-track preview.
  // --------------------------------------------------------------

  plState(item) {
    if (!item.__pl) item.__pl = { loading: false, error: null, items: null, selected: null, expanded: false };
    return item.__pl;
  }

  async togglePlaylistDetail(idx) {
    const item = this.results[idx];
    if (!item || item.type !== 'playlist') return;
    const st = this.plState(item);
    if (st.items) { st.expanded = !st.expanded; this.renderResults(); this.updateSelectedCount(); return; }
    if (st.loading) return;
    st.loading = true;
    st.error = null;
    st.expanded = true;
    this.renderResults();
    try {
      const r = await fetch(`/api/media/resolve?url=${encodeURIComponent(item.url)}`);
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
      st.items = (d.items || []).filter((t) => t.url);
      // 默认全选：master checked → every track selected.
      st.selected = new Set(st.items.map((_, i) => i));
    } catch (e) {
      st.error = e.message;
    } finally {
      st.loading = false;
      this.renderResults();
      this.updateSelectedCount();
    }
  }

  renderPlaylistChildren(container, item, idx) {
    const st = this.plState(item);
    container.innerHTML = '';
    if (!st.expanded) { container.hidden = true; return; }
    container.hidden = false;
    const wrap = document.createElement('div');
    wrap.className = 'media-row-children';
    if (st.loading) {
      wrap.innerHTML = `<div class="media-pl-status">${this.tt('home.plLoading', '加载曲目…')}</div>`;
    } else if (st.error) {
      wrap.innerHTML = `<div class="media-pl-status err">${this.tt('home.plFailed', '歌单加载失败')}: </div>`;
      wrap.querySelector('.media-pl-status.err').append(document.createTextNode(st.error || ''));
    } else if (!st.items) {
      wrap.innerHTML = `<div class="media-pl-status">${this.tt('home.plHint', '点击展开查看曲目')}</div>`;
    } else {
      st.items.forEach((t, ti) => {
        const row = this.buildMediaRow(t, ti, { trackOf: idx });
        const cb = row.querySelector('.media-track-check');
        if (cb) cb.checked = st.selected.has(ti);
        wrap.appendChild(row);
      });
    }
    container.appendChild(wrap);
  }

  // Track checkbox change → refresh the playlist master (all/some/none).
  syncPlaylistMaster(idx) {
    const item = this.results[idx];
    if (!item) { this.updateSelectedCount(); return; }
    const st = this.plState(item);
    if (st.items && st.selected) {
      st.selected = new Set([...this.resultsList.querySelectorAll(`.media-track-check[data-parent="${idx}"]:checked`)].map((c) => Number(c.dataset.idx)));
      const master = this.resultsList.querySelector(`.media-group-check[data-idx="${idx}"]`);
      if (master) {
        master.checked = st.selected.size === st.items.length;
        master.indeterminate = st.selected.size > 0 && st.selected.size < st.items.length;
      }
    }
    this.updateSelectedCount();
  }

  // Master checkbox change → select / deselect every loaded track.
  onPlaylistMasterToggle(idx) {
    const item = this.results[idx];
    if (!item) { this.updateSelectedCount(); return; }
    const st = this.plState(item);
    const master = this.resultsList.querySelector(`.media-group-check[data-idx="${idx}"]`);
    const checked = master?.checked ?? true;
    if (st.items && st.selected) {
      st.selected = checked ? new Set(st.items.map((_, i) => i)) : new Set();
      this.resultsList.querySelectorAll(`.media-track-check[data-parent="${idx}"]`).forEach((c) => { c.checked = checked; });
    }
    this.updateSelectedCount();
  }

  renderResults() {
    if (!this.resultsList) return;
    this.resultsList.innerHTML = '';
    this.results.forEach((item, idx) => {
      if (item.type === 'playlist') {
        const group = document.createElement('div');
        group.className = 'media-group';
        group.appendChild(this.buildMediaRow(item, idx));
        const children = document.createElement('div');
        children.className = 'media-group-children';
        this.renderPlaylistChildren(children, item, idx);
        group.appendChild(children);
        this.resultsList.appendChild(group);
      } else {
        this.resultsList.appendChild(this.buildMediaRow(item, idx));
      }
    });
  }

  // ------------------------------------------------------------------
  // Mini preview player: audio streams for QQ/NetEase, iframe embeds for
  // YouTube/Bilibili. One singleton bar at the bottom of the page.
  // ------------------------------------------------------------------

  playPreview(item, btn) {
    if (!item || item.type === 'playlist') return;
    const key = `${item.platform}:${item.id}`;
    // Clicking the playing row's button again toggles playback off.
    if (this.playingKey === key) { this.closePreview(); return; }
    this.closePreview();
    const bar = document.getElementById('miniPlayer');
    if (!bar) return;
    const body = bar.querySelector('.mini-player__body');
    const title = `${item.title || ''}${item.artist ? ' — ' + item.artist : ''}`;
    if (item.platform === 'youtube') {
      body.innerHTML = `<iframe class="mini-player__frame" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(item.id)}?autoplay=1" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
    } else if (item.platform === 'spotify') {
      body.innerHTML = `<iframe class="mini-player__frame mini-player__frame--spotify" src="https://open.spotify.com/embed/${item.type === 'playlist' ? 'playlist' : 'track'}/${encodeURIComponent(item.id)}?utm_source=gharmonize" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
    } else if (item.platform === 'bilibili') {
      body.innerHTML = `<iframe class="mini-player__frame" src="https://player.bilibili.com/player.html?bvid=${encodeURIComponent(item.id)}&autoplay=1&high_quality=0&danmaku=0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
    } else if (item.platform === 'netease' || item.platform === 'qqmusic') {
      body.innerHTML = `<audio class="mini-player__audio" controls autoplay src="/api/media/stream?platform=${encodeURIComponent(item.platform)}&id=${encodeURIComponent(item.id)}"></audio>`;
    } else {
      this.notify(this.tt('home.previewUnavailable', '该平台暂不支持试听'), 'info');
      return;
    }
    bar.querySelector('.mini-player__title').textContent = title;
    bar.hidden = false;
    this.setPlayingUi(key, btn);
    // Surface failures (VIP-only songs return 404) instead of failing silently.
    body.querySelector('audio')?.addEventListener('error', () => {
      this.notify(this.tt('home.previewUnavailable', '该平台暂不支持试听'), 'error');
      this.closePreview();
    });
  }

  setPlayingUi(key, btn) {
    this.playingKey = key;
    document.querySelectorAll('.media-play.playing').forEach((b) => {
      b.classList.remove('playing');
      b.textContent = '▶';
    });
    if (btn) {
      btn.classList.add('playing');
      btn.textContent = '⏸';
    }
  }

  closePreview() {
    const bar = document.getElementById('miniPlayer');
    if (bar) {
      bar.hidden = true;
      bar.querySelector('.mini-player__body').innerHTML = ''; // stops audio + removes iframes
    }
    this.playingKey = null;
    document.querySelectorAll('.media-play.playing').forEach((b) => {
      b.classList.remove('playing');
      b.textContent = '▶';
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
    const n = (this.resultsList?.querySelectorAll('.media-item-check:checked').length || 0) +
      (this.resultsList?.querySelectorAll('.media-group-check:checked').length || 0);
    if (this.downloadBtn) this.downloadBtn.disabled = n === 0;
  }

  // Submits one /api/jobs job per selected item, using the settings-page
  // preferences (convert checkbox → format/bitrate; unchecked = ORIGINAL).
  // Playlist items are expanded into their tracks first so every item gets its
  // own progress row and failure reason. Optional per-download subfolder.
  // Expands one playlist item into the download queue. When the detail track
  // list is loaded, only the CHECKED tracks are queued (未展开/未加载 → 全部).
  async pushPlaylistTracks(queue, item, masterChecked) {
    const st = this.plState(item);
    if (st.items && st.items.length) {
      const chosen = (st.selected ? [...st.selected] : st.items.map((_, i) => i))
        .sort((a, b) => a - b)
        .map((i) => st.items[i])
        .filter(Boolean);
      if (!chosen.length) return;
      queue.push(...chosen.map((t) => ({
        ...t,
        platform: t.platform || item.platform,
        fromPlaylist: item.title,
        ...(item._override ? { _override: item._override } : {})
      })));
      return;
    }
    try {
      const r = await fetch(`/api/media/resolve?url=${encodeURIComponent(item.url)}`);
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
      const tracks = (d.items || []).map((t) => ({
        ...t,
        platform: item.platform,
        fromPlaylist: item.title,
        ...(item._override ? { _override: item._override } : {})
      }));
      this.notify(`${this.tt('home.expandPlaylists', '歌单已展开')}: ${item.title} → ${tracks.length}`, 'info');
      if (tracks.length) queue.push(...tracks);
    } catch (err) {
      queue.push({ ...item, status: 'failed', error: `${this.tt('home.expandFailed', '歌单解析失败')}: ${err.message}`, progress: 0 });
    }
  }

  async downloadSelected() {
    if (this.submitting) return;
    const checked = [...(this.resultsList?.querySelectorAll('.media-item-check:checked') || [])];
    const groups = [...(this.resultsList?.querySelectorAll('.media-group-check:checked') || [])];
    if (!checked.length && !groups.length) { this.notify(this.tt('home.selectRequired', '请先勾选要下载的条目'), 'error'); return; }
    const selected = checked.map((c) => this.results[Number(c.dataset.idx)]).filter(Boolean);
    // Playlist groups: master checked → its selected tracks (or expand-all
    // when the track list was never loaded); unchecked → skip entirely.
    const playlists = groups.map((g) => ({ item: this.results[Number(g.dataset.idx)], masterChecked: true })).filter((g) => g.item);

    this.submitting = true;
    this.downloadBtn?.setAttribute('disabled', '1');

    // Expand playlists into track lists (details visible in the queue).
    const queue = [];
    for (const item of selected) {
      if (item.type === 'playlist') {
        await this.pushPlaylistTracks(queue, item, /* masterChecked */ true);
      } else {
        queue.push({ ...item });
      }
    }
    for (const { item } of playlists) {
      if (item.type === 'playlist') await this.pushPlaylistTracks(queue, item, true);
    }
    if (!queue.length) {
      this.submitting = false;
      this.downloadBtn?.removeAttribute('disabled');
      return;
    }

    // Queue rows: pending → queued → processing → completed/error.
    // Each row freezes its own effective format/bitrate/subdir at submit time
    // (song scope for singles, playlist scope for expanded lists).
    this.queueRows = queue.map((it) => ({
      ...it,
      jobId: null,
      status: 'pending',
      progress: 0,
      error: it.error || null,
      cfg: this.resolveRowCfg(it)
    }));
    this.renderQueue();
    this.downloadQueueEl.style.display = '';
    this.setDlTab('status');
    this.showView('download');
    this.downloadQueueEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    let ok = 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const row of this.queueRows) {
      if (row.status === 'failed') continue;
      // Pace submissions: POST /api/jobs is rate limited (60/min) server-side.
      if (ok > 0) await sleep(1_100);
      try {
        const resp = await fetch('/api/jobs', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: row.url,
            format: row.cfg.format,
            bitrate: row.cfg.bitrate,
            isPlaylist: false,
            sampleRate: 48000,
            autoCreateZip: false,
            title: row.title || '',
            artist: row.artist || '',
            ...(row.cfg.subdir ? { outputSubdir: row.cfg.subdir } : {}),
            ...(row.cfg.rename ? { rename: row.cfg.rename } : {})
          })
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && (data.id || data.ok || data.data?.id)) {
          row.jobId = data.id || data.data?.id;
          row.status = 'queued';
          row.error = null;
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

  // ------------------------------------------------------------------
  // Download module: sub-tabs, status filter, per-scope config
  // ------------------------------------------------------------------

  setDlTab(tab) {
    this.dlTab = ['config', 'library'].includes(tab) ? tab : 'status';
    this.dlSubTabsEl?.querySelectorAll('.dl-subtab').forEach((t) => {
      const active = t.dataset.dltab === this.dlTab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (this.dlStatusPane) this.dlStatusPane.hidden = this.dlTab !== 'status';
    if (this.dlConfigPane) this.dlConfigPane.hidden = this.dlTab !== 'config';
    if (this.dlLibraryPane) this.dlLibraryPane.hidden = this.dlTab !== 'library';
    if (this.dlTab === 'config') this.populateScopeConfig();
    if (this.dlTab === 'library') this.loadLibrary();
  }

  // 音乐库: scans the server's download directory on disk and groups files by
  // folder (base data), enriched with SQLite metadata; played via /download/….
  async loadLibrary() {
    this.libraryGroups = [];
    try {
      const r = await fetch('/api/media/library-tree');
      const d = await r.json();
      this.libraryGroups = Array.isArray(d?.groups) ? d.groups : [];
    } catch {
      this.libraryGroups = [];
    }
    this.renderLibrary();
  }

  renderLibrary() {
    if (!this.dlLibraryList) return;
    this.dlLibraryList.innerHTML = '';
    const groups = this.libraryGroups || [];
    if (this.dlLibraryEmpty) this.dlLibraryEmpty.style.display = groups.length ? 'none' : '';
    for (const g of groups) this.dlLibraryList.appendChild(this.libraryGroup(g));
  }

  libraryGroup(g) {
    const group = document.createElement('div');
    group.className = 'media-group lib-group';
    const head = document.createElement('div');
    head.className = 'lib-group-head';
    const mb = g.total ? ` · ${(g.total / 1048576).toFixed(1)}MB` : '';
    head.innerHTML = `
      <button type="button" class="media-expand lib-expand" aria-label="toggle"><span class="media-expand-arrow">▾</span></button>
      <span class="lib-group-name"></span>
      <span class="lib-group-meta">${g.files.length} 首${mb}</span>`;
    head.querySelector('.lib-group-name').textContent = g.dir === '/' ? '（根目录）' : g.dir;
    const body = document.createElement('div');
    body.className = 'lib-group-body';
    for (const f of g.files) body.appendChild(this.libraryRow(f));
    head.querySelector('.lib-expand').addEventListener('click', () => {
      body.hidden = !body.hidden;
      head.querySelector('.media-expand-arrow').textContent = body.hidden ? '▸' : '▾';
    });
    group.append(head, body);
    return group;
  }

  libraryRow(f) {
    const row = document.createElement('div');
    row.className = 'media-row lib-row';
    const sizeTxt = f.size ? ` · ${(f.size / 1048576).toFixed(1)}MB` : '';
    const fmtTxt = `${(f.format || '').toUpperCase()}${sizeTxt}`;
    row.innerHTML = `
      <button type="button" class="media-play lib-play" aria-label="Play">▶</button>
      <span class="media-row-body">
        <span class="media-row-main">
          ${f.platform ? `<span class="media-item-platform">${this.platTag(f.platform)}</span>` : ''}
          <span class="media-item-title"></span>
        </span>
        <span class="media-row-meta">
          <span class="media-chip fmt">${fmtTxt}</span>
          ${f.duration_sec ? `<span class="media-chip">${Math.round(f.duration_sec / 60)}:${String(Math.round(f.duration_sec) % 60).padStart(2, '0')}</span>` : ''}
          ${f.mtime ? `<span class="media-chip">${new Date(f.mtime).toLocaleDateString()}</span>` : ''}
        </span>
        <span class="media-row-sub"></span>
      </span>
      <button type="button" class="lib-del icon-btn" title="${this.tt('home.libDelete', '删除文件')}">🗑</button>`;
    row.querySelector('.media-item-title').textContent = f.title || f.name;
    const sub = row.querySelector('.media-row-sub');
    const stem = f.name.replace(/\.[^.]*$/, '');
    const meta = [f.artist, f.title && stem !== f.title ? f.name : null].filter(Boolean).join(' · ');
    if (meta) sub.textContent = meta; else sub.remove();
    const btn = row.querySelector('.lib-play');
    btn?.addEventListener('click', () => this.playLocal(f, btn));
    row.querySelector('.lib-del')?.addEventListener('click', () => this.deleteLibraryFile(f));
    return row;
  }

  async deleteLibraryFile(f) {
    if (!f?.path) return;
    if (!window.confirm(`${this.tt('home.libDeleteConfirm', '确认删除该文件（不可恢复）？')}\n${f.title || f.name}`)) return;
    try {
      const r = await fetch(`/api/media/library-file?path=${encodeURIComponent(f.path)}`, { method: 'DELETE', credentials: 'include' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
      this.notify(`${this.tt('home.libDeleted', '已删除')}: ${f.title || f.name}`, 'info');
      this.loadLibrary();
    } catch (err) {
      this.notify(`${this.tt('home.libDeleteFailed', '删除失败')}: ${err.message}`, 'error');
    }
  }

  // Plays a finished LOCAL file through the mini player (default source is
  // the server's own copy — no remote stream involved).
  playLocal(file, btn) {
    const src = file.file_path || file.path;
    const key = `local:${file.id || src}`;
    if (this.playingKey === key) { this.closePreview(); return; }
    this.closePreview();
    const bar = document.getElementById('miniPlayer');
    if (!bar || !src) return;
    const body = bar.querySelector('.mini-player__body');
    body.innerHTML = `<audio class="mini-player__audio" controls autoplay src="${encodeURI(src)}"></audio>`;
    bar.querySelector('.mini-player__title').textContent =
      [file.title, file.artist].filter(Boolean).join(' — ') || '本地播放';
    bar.hidden = false;
    this.setPlayingUi(key, btn);
    body.querySelector('audio')?.addEventListener('error', () => {
      this.notify(this.tt('home.previewUnavailable', '该平台暂不支持试听'), 'error');
      this.closePreview();
    });
  }

  rowKind(row) {
    return (row.fromPlaylist || row.type === 'playlist') ? 'playlist' : 'song';
  }

  persistScopeCfg() {
    const read = (fmtSel, brSel, dirInput, renameInput) => ({
      format: fmtSel?.value || 'default',
      bitrate: brSel?.value || 'auto',
      subdir: String(dirInput?.value || '').trim().replace(/^\/+|\/+$/g, ''),
      rename: String(renameInput?.value || '').trim()
    });
    this.dlCfg.song = read(this.cfgSongFormatSelect, this.cfgSongBitrateSelect, this.cfgSongSubdirInput, this.cfgSongRenameInput);
    this.dlCfg.playlist = read(this.cfgListFormatSelect, this.cfgListBitrateSelect, this.cfgListSubdirInput, this.cfgListRenameInput);
    try { localStorage.setItem('gharmonize_dl_scope_cfg', JSON.stringify(this.dlCfg)); } catch { /* ignore */ }
  }

  restoreScopeCfg() {
    // Templates must load even on first run (no saved scope config yet).
    this.loadTemplates();
    try {
      const raw = localStorage.getItem('gharmonize_dl_scope_cfg');
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved?.song) this.dlCfg.song = { ...this.dlCfg.song, ...saved.song };
      if (saved?.playlist) this.dlCfg.playlist = { ...this.dlCfg.playlist, ...saved.playlist };
    } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Download settings templates: {name, format, bitrate, subdir, rename}
  // ------------------------------------------------------------------
  readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }

  loadTemplates() {
    const list = this.readJson('gharmonize_dl_templates', null);
    this.dlTemplates = Array.isArray(list) && list.length ? list : [
      { name: '默认（跟随设置）', format: 'default', bitrate: 'auto', subdir: '', rename: '' },
      { name: 'MP3 320k', format: 'mp3', bitrate: '320k', subdir: '', rename: '{artist} - {title}' },
      { name: 'FLAC 原音质', format: 'flac', bitrate: 'auto', subdir: 'FLAC', rename: '{artist} - {title}' }
    ];
    this.populateTemplateSelect();
  }

  persistTemplates() {
    try { localStorage.setItem('gharmonize_dl_templates', JSON.stringify(this.dlTemplates || [])); } catch { /* ignore */ }
  }

  populateTemplateSelect() {
    if (!this.tplSelect) return;
    this.tplSelect.innerHTML = '';
    for (const t of this.dlTemplates || []) {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name;
      this.tplSelect.appendChild(opt);
    }
  }

  applyTemplate() {
    const tpl = (this.dlTemplates || []).find((t) => t.name === this.tplSelect?.value);
    if (!tpl) { this.notify(this.tt('home.tplMissing', '请先选择模板'), 'error'); return; }
    for (const scope of ['song', 'playlist']) {
      this.dlCfg[scope] = { ...this.dlCfg[scope], format: tpl.format, bitrate: tpl.bitrate, subdir: tpl.subdir || '', rename: tpl.rename || '' };
    }
    this.populateScopeConfig();
    this.persistScopeCfg();
    this.notify(`${this.tt('home.tplApplied', '模板已应用')}: ${tpl.name}`, 'info');
  }

  saveTemplateFromCurrent() {
    const name = window.prompt(this.tt('home.tplNamePrompt', '模板名称'), this.tplSelect?.value || '');
    if (!name) return;
    const tpl = { name: name.trim(), format: this.dlCfg.song.format, bitrate: this.dlCfg.song.bitrate, subdir: this.dlCfg.song.subdir, rename: this.dlCfg.song.rename };
    this.dlTemplates = (this.dlTemplates || []).filter((t) => t.name !== tpl.name);
    this.dlTemplates.push(tpl);
    this.persistTemplates();
    this.populateTemplateSelect();
    if (this.tplSelect) this.tplSelect.value = tpl.name;
    this.notify(`${this.tt('home.tplSaved', '模板已保存')}: ${tpl.name}`, 'info');
  }

  deleteTemplate() {
    const name = this.tplSelect?.value;
    if (!name) return;
    this.dlTemplates = (this.dlTemplates || []).filter((t) => t.name !== name);
    this.persistTemplates();
    this.populateTemplateSelect();
    this.notify(`${this.tt('home.tplDeleted', '模板已删除')}: ${name}`, 'info');
  }

  // Per-item ⚙ override dialog (single song or whole playlist group).
  openRowCfgDialog(idx, isPlaylist) {
    const item = this.results?.[idx];
    if (!item) return;
    const base = item._override || this.dlCfg[isPlaylist ? 'playlist' : 'song'] || {};
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `
      <div class="modal-card">
        <h3>⚙ ${this.tt('home.rowCfgTitle', '此条目下载设置')}</h3>
        <p class="comment row-cfg-name"></p>
        <div class="form-group"><label>${this.tt('home.tplSelect', '模板')}</label>
          <select class="form-control rowcfg-tpl"></select></div>
        <div class="form-group"><label>${this.tt('media.format', '格式')}</label>
          <select class="form-control rowcfg-format"></select></div>
        <div class="form-group"><label>${this.tt('media.bitrate', '码率')}</label>
          <select class="form-control rowcfg-bitrate"></select></div>
        <div class="form-group"><label>${this.tt('home.subdirLabel', '子目录')}</label>
          <input type="text" class="form-control rowcfg-subdir" placeholder="子目录（可留空）"></div>
        <div class="form-group"><label>${this.tt('home.renameLabel', '重命名规则')}</label>
          <input type="text" class="form-control rowcfg-rename" placeholder="{artist} - {title}（可留空）"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-primary rowcfg-save">${this.tt('home.rowCfgSave', '仅此条目生效')}</button>
          <button type="button" class="btn rowcfg-tplsave">${this.tt('home.tplSave', '当前存为模板')}</button>
          <button type="button" class="btn rowcfg-clear">${this.tt('home.rowCfgClear', '清除覆盖')}</button>
          <button type="button" class="btn rowcfg-close">${this.tt('ui.close', '关闭')}</button>
        </div>
      </div>`;
    ov.querySelector('.row-cfg-name').textContent = item.title || '';
    const fmtSel = ov.querySelector('.rowcfg-format');
    const brSel = ov.querySelector('.rowcfg-bitrate');
    this.fillScopeSelects(fmtSel, brSel, base);
    ov.querySelector('.rowcfg-subdir').value = base.subdir || '';
    ov.querySelector('.rowcfg-rename').value = base.rename || '';
    const tplSel = ov.querySelector('.rowcfg-tpl');
    for (const t of this.dlTemplates || []) {
      const o = document.createElement('option');
      o.value = t.name;
      o.textContent = t.name;
      tplSel.appendChild(o);
    }
    tplSel.addEventListener('change', () => {
      const t = (this.dlTemplates || []).find((x) => x.name === tplSel.value);
      if (!t) return;
      this.fillScopeSelects(fmtSel, brSel, t);
      ov.querySelector('.rowcfg-subdir').value = t.subdir || '';
      ov.querySelector('.rowcfg-rename').value = t.rename || '';
    });
    ov.querySelector('.rowcfg-save').addEventListener('click', () => {
      item._override = {
        format: fmtSel.value, bitrate: brSel.value,
        subdir: ov.querySelector('.rowcfg-subdir').value.trim().replace(/^\/+|\/+$/g, ''),
        rename: ov.querySelector('.rowcfg-rename').value.trim()
      };
      ov.remove();
      this.notify(this.tt('home.rowCfgSaved', '已保存此条目的下载设置'), 'info');
    });
    ov.querySelector('.rowcfg-tplsave').addEventListener('click', () => {
      const name = window.prompt(this.tt('home.tplNamePrompt', '模板名称'), tplSel.value || '');
      if (!name) return;
      const tpl = { name: name.trim(), format: fmtSel.value, bitrate: brSel.value, subdir: ov.querySelector('.rowcfg-subdir').value.trim(), rename: ov.querySelector('.rowcfg-rename').value.trim() };
      this.dlTemplates = (this.dlTemplates || []).filter((t) => t.name !== tpl.name);
      this.dlTemplates.push(tpl);
      this.persistTemplates();
      this.populateTemplateSelect();
      if (this.tplSelect) this.tplSelect.value = tpl.name;
    });
    ov.querySelector('.rowcfg-clear').addEventListener('click', () => { delete item._override; ov.remove(); });
    ov.querySelector('.rowcfg-close').addEventListener('click', () => ov.remove());
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
    document.body.appendChild(ov);
  }

  fillScopeSelects(fmtSel, brSel, cfg) {
    if (!fmtSel) return;
    // Rebuild options on every call so repeated populates stay idempotent.
    fmtSel.innerHTML = '';
    const def = document.createElement('option');
    def.value = 'default';
    def.textContent = this.tt('home.followSettings', '跟随设置');
    fmtSel.appendChild(def);
    const orig = document.createElement('option');
    orig.value = 'original';
    orig.textContent = this.tt('nav.dlOverrideOriginal', '不转换（原样）');
    fmtSel.appendChild(orig);
    for (const f of this.formats) {
      if (f.format === 'original') continue; // already added above
      const opt = document.createElement('option');
      opt.value = f.format;
      opt.textContent = f.format.toUpperCase();
      fmtSel.appendChild(opt);
    }
    fmtSel.value = [...fmtSel.options].some((o) => o.value === cfg.format) ? cfg.format : 'default';
    // Bitrates follow the chosen concrete format; hidden for default/original.
    brSel.innerHTML = '';
    const fmtObj = this.formats.find((f) => f.format === cfg.format);
    for (const br of (fmtObj?.bitrates || ['auto'])) {
      const opt = document.createElement('option');
      opt.value = br;
      opt.textContent = br === 'lossless' ? this.tt('home.lossless', '无损') : br;
      brSel.appendChild(opt);
    }
    if (brSel.querySelector(`option[value="${CSS.escape(cfg.bitrate)}"]`)) brSel.value = cfg.bitrate;
    const showBr = !!fmtObj;
    if (brSel) brSel.disabled = !showBr;
  }

  populateScopeConfig() {
    this.fillScopeSelects(this.cfgSongFormatSelect, this.cfgSongBitrateSelect, this.dlCfg.song);
    this.fillScopeSelects(this.cfgListFormatSelect, this.cfgListBitrateSelect, this.dlCfg.playlist);
    if (this.cfgSongSubdirInput && document.activeElement !== this.cfgSongSubdirInput) this.cfgSongSubdirInput.value = this.dlCfg.song.subdir || '';
    if (this.cfgListSubdirInput && document.activeElement !== this.cfgListSubdirInput) this.cfgListSubdirInput.value = this.dlCfg.playlist.subdir || '';
    if (this.cfgSongRenameInput && document.activeElement !== this.cfgSongRenameInput) this.cfgSongRenameInput.value = this.dlCfg.song.rename || '';
    if (this.cfgListRenameInput && document.activeElement !== this.cfgListRenameInput) this.cfgListRenameInput.value = this.dlCfg.playlist.rename || '';
  }

  syncScopeBitrates() {
    this.persistScopeCfg();
    this.fillScopeSelects(this.cfgSongFormatSelect, this.cfgSongBitrateSelect, this.dlCfg.song);
    this.fillScopeSelects(this.cfgListFormatSelect, this.cfgListBitrateSelect, this.dlCfg.playlist);
  }

  // Effective format/bitrate/subdir/rename for one queue row: per-item
  // override wins, then the concrete scope config; 'default' falls back to
  // the settings-page download defaults.
  resolveRowCfg(row) {
    const scope = { ...(this.dlCfg[this.rowKind(row)] || this.dlCfg.song) };
    const ov = row._override;
    if (ov) Object.assign(scope, ov);
    const convert = !!this.convertCheckbox?.checked;
    const defFormat = convert ? (this.formatSelect?.value || 'mp3') : 'original';
    const defBitrate = defFormat === 'original' ? 'auto' : (this.bitrateSelect?.value || '320k');
    const format = scope.format === 'default' ? defFormat : scope.format;
    const bitrate = format === 'original' ? 'auto' : (scope.format === 'default' ? defBitrate : (scope.bitrate || 'auto'));
    return { format, bitrate, subdir: scope.subdir || '', rename: scope.rename || '' };
  }

  // ------------------------------------------------------------------
  // PARSE view: expand any platform link / playlist into items
  // ------------------------------------------------------------------

  async resolveParse() {
    const url = String(this.parseUrlInput?.value || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      this.notify(this.tt('home.parseUrlRequired', '请输入有效的链接'), 'error');
      return;
    }
    this.parseBtn?.setAttribute('disabled', '1');
    try {
      const r = await fetch(`/api/media/resolve?url=${encodeURIComponent(url)}`);
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
      const items = Array.isArray(d.items) ? d.items : [];
      this.parsedItems = items.map((it) => ({ ...it, platform: it.platform || 'unknown' }));
      if (this.parseResultsWrap) this.parseResultsWrap.style.display = '';
      if (this.parseMeta) {
        this.parseMeta.textContent = `${d.title || ''}（${d.totalCount ?? items.length} 项）`;
      }
      this.renderParseResults();
      this.parseResultsWrap?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      this.notify(`${this.tt('home.parseFailed', '解析失败')}: ${err.message}`, 'error');
    } finally {
      this.parseBtn?.removeAttribute('disabled');
    }
  }

  renderParseResults() {
    if (!this.parseResultsList) return;
    this.parseResultsList.innerHTML = '';
    this.parsedItems.forEach((item, idx) => this.parseResultsList.appendChild(this.buildMediaRow(item, idx)));
  }

  // Downloads the checked PARSE results (reuses the DOWNLOAD queue pipeline).
  async downloadParsed() {
    const checked = [...(this.parseResultsList?.querySelectorAll('.media-item-check:checked') || [])].map((c) => this.parsedItems[Number(c.dataset.idx)]).filter(Boolean);
    if (!checked.length) {
      this.notify(this.tt('home.selectRequired', '请先勾选要下载的条目'), 'error');
      return;
    }
    this.results = checked;
    this.downloadSelected();
  }

  // Polls the batched jobs-status endpoint until every row reaches a terminal state.
  async pollQueueStatuses() {
    if (this._queuePollTimer) clearInterval(this._queuePollTimer);
    const retryBtn = document.getElementById('retryFailedBtn');
    const tick = async () => {
      const rows = this.queueRows || [];
      const failed = rows.filter((r) => r.status === 'failed').length;
      if (retryBtn) retryBtn.style.display = failed ? '' : 'none';
      const ids = rows.map((r) => r.jobId).filter(Boolean);
      if (!ids.length) {
        if (retryBtn && failed) return; // keep the retry button visible
        clearInterval(this._queuePollTimer);
        this._queuePollTimer = null;
        return;
      }
      try {
        const r = await fetch(`/api/media/jobs-status?ids=${encodeURIComponent(ids.join(','))}`);
        const d = await r.json();
        const byId = new Map((d?.jobs || []).map((j) => [j.id, j]));
        let active = 0;
        for (const row of rows) {
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

  // Re-submits only the rows that failed during the original submission.
  async retryFailed() {
    const rows = (this.queueRows || []).filter((r) => r.status === 'failed');
    if (!rows.length) return;
    const retryBtn = document.getElementById('retryFailedBtn');
    if (retryBtn) retryBtn.setAttribute('disabled', '1');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let ok = 0;
    for (const row of rows) {
      if (ok > 0) await sleep(1_100);
      const cfg = row.cfg || this.resolveRowCfg(row);
      try {
        const resp = await fetch('/api/jobs', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: row.url,
            format: cfg.format,
            bitrate: cfg.bitrate,
            isPlaylist: false,
            sampleRate: 48000,
            autoCreateZip: false,
            title: row.title || '',
            artist: row.artist || '',
            ...(cfg.subdir ? { outputSubdir: cfg.subdir } : {})
          })
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && (data.id || data.ok || data.data?.id)) {
          row.jobId = data.id || data.data?.id;
          row.status = 'queued';
          row.progress = 0;
          row.error = null;
          ok += 1;
        } else {
          row.error = data?.error?.message || `HTTP ${resp.status}`;
        }
      } catch (err) {
        row.error = err.message;
      }
      this.renderQueue();
    }
    if (retryBtn) retryBtn.removeAttribute('disabled');
    if (ok > 0) this.pollQueueStatuses();
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

  // Re-submits ONE failed row (per-row ↻ button), keeping format/bitrate and
  // the original output subfolder.
  async retryOne(row) {
    if (!row?.url || this.submitting) return;
    const divs = [...(this.downloadQueueList?.querySelectorAll('.dq-retry') || [])];
    const btn = divs.find((b) => b.dataset.rowid === (row.jobId || row.url));
    btn?.setAttribute('disabled', '1');
    try {
      const resp = await fetch('/api/jobs', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: row.url,
          format: row.format || 'original',
          bitrate: row.bitrate || 'auto',
          isPlaylist: false,
          sampleRate: row.sampleRate || 48000,
          autoCreateZip: false,
          title: row.title || '',
          artist: row.artist || '',
          ...(row.outputSubdir ? { outputSubdir: row.outputSubdir } : {}),
          ...(row.rename ? { rename: row.rename } : {})
        })
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && (data.id || data.ok || data.data?.id)) {
        const oldId = row.jobId;
        row.jobId = data.id || data.data?.id;
        row.status = 'queued';
        row.progress = 0;
        row.error = null;
        if (oldId && this.retryIdMap) this.retryIdMap[oldId] = row.jobId;
        this.renderQueue();
        this.pollQueueStatuses();
      } else {
        row.error = data?.error?.message || `HTTP ${resp.status}`;
        this.renderQueue();
      }
    } catch (err) {
      row.error = err.message;
      this.renderQueue();
    }
  }

  renderQueue() {
    if (!this.downloadQueueList) return;
    this.downloadQueueList.innerHTML = '';
    const rows = (this.queueRows || []).filter((r) => !r.jobId || !this.hiddenJobIds.has(r.jobId));
    const visible = rows.filter((r) => this.dlStatusFilter === 'all' || this.rowKind(r) === this.dlStatusFilter);
    // Pagination: keep long backlogs manageable (50 rows per page).
    const pages = Math.max(1, Math.ceil(visible.length / this.queuePageSize));
    this.queuePage = Math.min(Math.max(1, this.queuePage), pages);
    const pageRows = visible.slice((this.queuePage - 1) * this.queuePageSize, this.queuePage * this.queuePageSize);
    // Playlist tracks (fromPlaylist) collapse under a group header; singles
    // stay standalone — mirroring the search view's song/playlist layout.
    const blocks = [];
    const plIndex = new Map();
    for (const row of pageRows) {
      const key = row.fromPlaylist || null;
      if (!key) { blocks.push({ single: row }); continue; }
      if (!plIndex.has(key)) { plIndex.set(key, { title: key, tracks: [] }); blocks.push(plIndex.get(key)); }
      plIndex.get(key).tracks.push(row);
    }
    for (const block of blocks) {
      if (block.single) {
        this.downloadQueueList.appendChild(this.buildQueueRow(block.single));
        continue;
      }
      const group = document.createElement('div');
      group.className = 'media-group dq-group';
      const doneN = block.tracks.filter((t) => t.status === 'completed').length;
      const head = document.createElement('div');
      head.className = 'lib-group-head';
      head.innerHTML = `<span class="lib-group-name">📃 <span class="dq-group-name"></span></span>
        <span class="lib-group-meta">${block.tracks.length} 首 · ${this.tt('home.jobDone', '完成')} ${doneN}</span>`;
      head.querySelector('.dq-group-name').textContent = block.title;
      const body = document.createElement('div');
      body.className = 'lib-group-body';
      for (const t of block.tracks) body.appendChild(this.buildQueueRow(t));
      head.addEventListener('click', () => { body.hidden = !body.hidden; });
      group.append(head, body);
      this.downloadQueueList.appendChild(group);
    }
    if (this.downloadQueueEl) this.downloadQueueEl.style.display = (this.queueRows || []).length ? '' : 'none';
    if (this.dqPager) {
      this.dqPager.hidden = visible.length <= this.queuePageSize;
      if (this.dqPageInfo) this.dqPageInfo.textContent = `${this.queuePage} / ${pages}`;
    }
    const done = rows.filter((r) => r.status === 'completed').length;
    const failed = rows.filter((r) => ['failed', 'error'].includes(r.status)).length;
    if (this.downloadQueueSummary) {
      this.downloadQueueSummary.textContent = `${this.tt('home.jobDone', '完成')} ${done} / ${rows.length}${failed ? ` • ${this.tt('home.jobFailed', '失败')} ${failed}` : ''}`;
    }
    if (this.clearDoneBtn) this.clearDoneBtn.style.display = done || failed ? '' : 'none';
  }

  // One rich queue row — same visual language as the search view — with
  // progress and a ✕ that only removes the row from the display (the job
  // record and any downloaded file stay untouched).
  buildQueueRow(row) {
    const div = document.createElement('div');
    div.className = 'media-row dq-row';
    const kindTag = this.rowKind(row) === 'playlist' ? '📃 ' : '';
    const chips = [];
    if (row.fileFormat || row.format) chips.push(`<span class="media-chip fmt">${row.fileFormat || row.format}${row.quality ? ' · ' + row.quality : ''}</span>`);
    if (row.vip) chips.push(`<span class="media-chip vip">👑 ${this.tt('home.vipRequired', 'VIP')}</span>`);
    if (row.cfg?.rename || row.rename) chips.push(`<span class="media-chip">🪄 ${row.cfg?.rename || row.rename}</span>`);
    div.innerHTML = `
      <span class="media-row-cover">🎵</span>
      <span class="media-row-body">
        <span class="media-row-main">
          <span class="media-item-platform">${this.platTag(row.platform)}</span>
          <span class="media-item-title"></span>
          ${row.durationSec ? `<span class="media-item-dur">${this.fmtDuration(row.durationSec)}</span>` : ''}
        </span>
        <span class="media-row-meta">${chips.join('')}</span>
        <span class="media-row-sub dq-artist"></span>
      </span>
      <span class="dq-side">
        <span class="dq-status">${this.queueStatusBadge(row)}</span>
        ${row.status === 'processing' ? `<span class="dq-pct">${row.progress || 0}%</span>` : ''}
        ${['failed', 'error', 'missing'].includes(row.status) ? `<button type="button" class="dq-retry icon-btn" title="${this.tt('home.retry', '重试')}">↻</button>` : ''}
        ${['completed', 'failed', 'error', 'canceled', 'cancelled', 'missing'].includes(row.status) ? `<button type="button" class="dq-dismiss icon-btn" title="${this.tt('home.dismissRow', '从列表移除（不删除数据）')}">✕</button>` : ''}
      </span>`;
    div.querySelector('.media-item-title').textContent = kindTag + (row.title || row.url || '');
    div.querySelector('.dq-artist').textContent = [row.artist, row.album].filter(Boolean).join(' — ');
    const rbtn = div.querySelector('.dq-retry');
    if (rbtn) rbtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.retryOne(row); });
    const xbtn = div.querySelector('.dq-dismiss');
    if (xbtn) xbtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.dismissRow(row); });
    return div;
  }

  // Display-only: forget a finished row in this list (job + file untouched).
  dismissRow(row) {
    const id = row.jobId || row.id;
    if (id) {
      this.hiddenJobIds.add(id);
      try { localStorage.setItem('gharmonize_dq_hidden', JSON.stringify([...this.hiddenJobIds].slice(-2000))); } catch { /* ignore */ }
    }
    this.queueRows = (this.queueRows || []).filter((r) => r !== row);
    this.renderQueue();
  }

  // 🧹 clears finished/failed rows from the list display only.
  clearFinishedRows() {
    const finished = new Set(['completed', 'failed', 'error', 'canceled', 'cancelled', 'missing']);
    for (const r of this.queueRows || []) {
      if (finished.has(r.status) && (r.jobId || r.id)) this.hiddenJobIds.add(r.jobId || r.id);
    }
    try { localStorage.setItem('gharmonize_dq_hidden', JSON.stringify([...this.hiddenJobIds].slice(-2000))); } catch { /* ignore */ }
    this.queueRows = (this.queueRows || []).filter((r) => !finished.has(r.status));
    this.renderQueue();
    this.notify(this.tt('home.clearedDone', '已清理列表（不删除数据/文件）'), 'info');
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
    this.restoreScopeCfg();
    this.populateScopeConfig();
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
      || `${location.protocol}//${location.hostname}:9223/`;
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
  // Views: home / search / download / disc / settings — routed via hash
  // ------------------------------------------------------------------

  applyRoute() {
    const raw = String(location.hash || '').replace(/^#\/?/, '').toLowerCase();
    const view = HomeApp.ROUTE_ALIASES[raw] || raw;
    this.showView(HomeApp.VIEWS[view] ? view : 'home', { push: false });
  }

  showView(view, { push = true } = {}) {
    if (!HomeApp.VIEWS[view]) view = 'home';
    for (const [name, id] of Object.entries(HomeApp.VIEWS)) {
      const el = document.getElementById(id);
      if (el) el.hidden = name !== view;
    }
    this.topTabsEl?.querySelectorAll('.top-tab[data-view]').forEach((tab) => {
      const active = tab.dataset.view === view;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (view === 'settings') {
      this.fillSettings();
      this.loadLogs();
      if (this._logTimer) clearInterval(this._logTimer);
      this._logTimer = setInterval(() => this.loadLogs(), 4000);
    } else if (this._logTimer) {
      clearInterval(this._logTimer);
      this._logTimer = null;
    }
    if (view === 'download') {
      this.loadToolsLine(this.dlToolsText);
      this.populateScopeConfig();
    }
    if (view === 'upload') this.loadToolsLine(this.uploadToolsText);
    // Disc progress SSE only runs while the Disc tab is visible.
    if (view === 'disc') startDiscProgressStream();
    else stopDiscProgressStream();
    if (push) {
      const hash = `#/${view}`;
      if (location.hash !== hash) location.hash = hash;
    }
    window.scrollTo({ top: 0 });
  }

  openBrowserTab() {
    window.open(this.browserBase(), '_blank', 'noopener,noreferrer');
  }

  async loadLogs() {
    if (!this.logLinesBox) return;
    try {
      const r = await fetch('/api/logs?limit=400');
      const d = await r.json();
      const lines = (d?.lines || []).map((l) => l.text).join('\n');
      this.logLinesBox.textContent = lines;
      this.logLinesBox.scrollTop = this.logLinesBox.scrollHeight;
    } catch { /* transient */ }
  }

  async loadToolsLine(targetEl) {
    if (!targetEl) return;
    try {
      const r = await fetch('/api/binaries/status');
      const d = await r.json();
      const names = ['yt-dlp', 'ffmpeg', 'ffprobe', 'mkvmerge', 'mkvpropedit', 'deno'];
      const parts = names.map((n) => {
        const info = d?.tools?.[n] || d?.[n];
        const ok = info ? (info.ok ?? info.available ?? info.version) : false;
        return `${n}: ${ok ? '✅' : '❌'}`;
      });
      targetEl.textContent = parts.join(' • ');
    } catch {
      targetEl.textContent = 'yt-dlp: ❓';
    }
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
      const dirChanged = updates.MEDIA_DOWNLOAD_DIR !== undefined && updates.MEDIA_DOWNLOAD_DIR !== (this.config?.downloadDir || '');
      this.notify(
        dirChanged
          ? `${this.tt('settings.saved', '设置已保存')} — ${this.tt('settings.restartHint', '修改下载目录需重启服务后生效')}`
          : this.tt('settings.saved', '设置已保存'),
        'success'
      );
      await this.loadConfig();
    } catch (err) {
      this.notify(`${this.tt('settings.saveFailed', '保存失败')}: ${err.message}`, 'error');
    } finally {
      if (btn) btn.removeAttribute('disabled');
    }
  }
}

export default HomeApp;
