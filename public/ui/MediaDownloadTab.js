// Media download tab: Bilibili URL resolve + platform search + batch download.
// Platforms: bilibili (login required) / qqmusic / netease.
export class MediaDownloadTab {
  constructor(app) {
    this.app = app;
    this.results = [];
    this.browserUrl = null;
    this.submitting = false;
  }

  // Entry point wired from main.js after the app finishes initializing.
  initialize() {
    this.cacheElements();
    this.bindEvents();
    this.loadOutputFormats();
    this.loadPlatformStatus();
  }

  cacheElements() {
    this.tabs = document.getElementById('mainTabs');
    this.paneConvert = document.getElementById('tab-pane-convert');
    this.paneMedia = document.getElementById('tab-pane-media');
    this.btnConvert = document.getElementById('tabBtnConvert');
    this.btnMedia = document.getElementById('tabBtnMedia');

    this.platformsEl = document.getElementById('mediaPlatforms');
    this.refreshLoginBtn = document.getElementById('mediaRefreshLoginBtn');

    this.biliModeSelect = document.getElementById('biliModeSelect');
    this.biliUrlInput = document.getElementById('biliUrlInput');
    this.biliResolveBtn = document.getElementById('biliResolveBtn');

    this.searchInput = document.getElementById('mediaSearchInput');
    this.searchBtn = document.getElementById('mediaSearchBtn');

    this.formatSelect = document.getElementById('mediaFormatSelect');
    this.bitrateSelect = document.getElementById('mediaBitrateSelect');
    this.bitrateGroup = document.getElementById('mediaBitrateGroup');
    this.downloadDirInput = document.getElementById('mediaDownloadDirInput');
    this.downloadDirSaveBtn = document.getElementById('mediaDownloadDirSaveBtn');

    this.resultsCard = document.getElementById('mediaResultsCard');
    this.resultsTitle = document.getElementById('mediaResultsTitle');
    this.resultsMeta = document.getElementById('mediaResultsMeta');
    this.resultsList = document.getElementById('mediaResultsList');
    this.selectAll = document.getElementById('mediaSelectAll');
    this.downloadBtn = document.getElementById('mediaDownloadBtn');
  }

  bindEvents() {
    if (this.btnConvert) {
      this.btnConvert.addEventListener('click', () => this.switchTab('convert'));
    }
    if (this.btnMedia) {
      this.btnMedia.addEventListener('click', () => this.switchTab('media'));
    }
    this.refreshLoginBtn?.addEventListener('click', () => this.loadPlatformStatus());
    this.biliResolveBtn?.addEventListener('click', () => this.resolveBilibili());
    this.searchBtn?.addEventListener('click', () => this.runSearch());
    this.searchInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.runSearch();
    });
    this.formatSelect?.addEventListener('change', () => this.syncBitrateOptions());
    this.downloadDirSaveBtn?.addEventListener('click', () => this.saveDownloadDir());
    this.selectAll?.addEventListener('change', () => {
      const checked = this.selectAll.checked;
      this.resultsList?.querySelectorAll('.media-item-check').forEach((c) => { c.checked = checked; });
      this.updateSelectedCount();
    });
    this.downloadBtn?.addEventListener('click', () => this.downloadSelected());
  }

  switchTab(name) {
    const isMedia = name === 'media';
    if (this.paneMedia) this.paneMedia.style.display = isMedia ? '' : 'none';
    if (this.paneConvert) this.paneConvert.style.display = isMedia ? 'none' : '';
    this.btnMedia?.classList.toggle('settings-btn--active', isMedia);
    this.btnConvert?.classList.toggle('settings-btn--active', !isMedia);
    if (isMedia) this.loadPlatformStatus();
  }

  notify(message, type = 'info') {
    this.app?.showNotification?.(message, type, type === 'error' ? 'error' : 'default');
  }

  // ------------------------------------------------------------------
  // Platform login status
  // ------------------------------------------------------------------

  browserFallbackUrl() {
    // When no external URL is configured, derive one from the page address:
    // same hostname + the host-mapped chrome-driverless port.
    return `${location.protocol}//${location.hostname}:9203/`;
  }

  async loadPlatformStatus() {
    // One card per platform; bililive/neteaselive reuse the Bilibili/NetEase
    // session (same cookie domain), youtube has its own Google sign-in.
    const labels = {
      bilibili: 'Bilibili 哔哩哔哩',
      bililive: 'Bilibili 直播',
      qqmusic: 'QQ 音乐',
      netease: '网易云音乐',
      neteaselive: '网易云电台 / 直播',
      youtube: 'YouTube'
    };
    const hints = {
      bilibili: '搜索与下载需登录（扫码）',
      bililive: '直播搜索需 B 站登录',
      qqmusic: '搜索无需登录，下载建议登录',
      netease: '搜索无需登录，下载建议登录',
      neteaselive: '电台搜索无需登录',
      youtube: '登录后解锁高音质 / 年龄限制'
    };
    const order = ['bilibili', 'bililive', 'qqmusic', 'netease', 'neteaselive', 'youtube'];
    // bililive & neteaselive share the bilibili / netease cookie session.
    const loginSourceOf = { bililive: 'bilibili', neteaselive: 'netease' };
    try {
      const r = await fetch('/api/media/config');
      const d = await r.json();
      if (d?.browserExternalUrl) this.browserUrl = d.browserExternalUrl;
      const platforms = d?.platforms || {};
      const loginUrls = d?.loginUrls || {};
      if (this.downloadDirInput) {
        this.downloadDirInput.value = d?.downloadDir || '';
        if (!this.downloadDirInput.dataset.loadedDefault && !d?.downloadDir) {
          this.downloadDirInput.value = '';
          this.downloadDirInput.dataset.loadedDefault = '1';
        }
      }
      const container = this.platformsEl;
      if (!container) return;
      container.innerHTML = '';
      for (const key of order) {
        const sourceKey = loginSourceOf[key] || key;
        const info = platforms[sourceKey] || {};
        const loggedIn = !!info.loggedIn;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 10px;border:1px solid rgba(128,128,128,.25);border-radius:8px;';
        row.innerHTML = `
          <span style="font-weight:600;min-width:140px;">${labels[key]}</span>
          <span style="font-size:.85em;color:var(--text-muted,rgba(128,128,128,.8));">${hints[key]}</span>
          <span class="media-login-badge" style="margin-left:auto;font-size:.85em;padding:2px 10px;border-radius:12px;background:${loggedIn ? 'rgba(46,160,67,.18)' : 'rgba(241,76,12,.18)'};color:${loggedIn ? '#2ea043' : '#f14c0c'};">
            ${loggedIn ? '✅ 已登录' : '⚠️ 未登录'}
          </span>
          <button type="button" class="btn-outline media-login-btn" data-platform="${key}" style="padding:4px 12px;font-size:.85em;">
            🛩️ 扫码登录
          </button>`;
        container.appendChild(row);
      }
      container.querySelectorAll('.media-login-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.platform;
          const base = this.browserUrl || this.browserFallbackUrl();
          // Deep-link straight to the QR/sign-in page inside the embedded browser.
          const targetUrl = loginUrls[key] || {
            bilibili: 'https://passport.bilibili.com/login',
            bililive: 'https://passport.bilibili.com/login',
            qqmusic: 'https://graph.qq.com/oauth2.0/show?which=Login&display=pc&client_id=100460100&response_type=code&redirect_uri=https%3A%2F%2Fy.qq.com%2Fportal%2Fplayer.html',
            netease: 'https://music.163.com/#/login',
            neteaselive: 'https://music.163.com/#/login',
            youtube: 'https://www.youtube.com/signin'
          }[key];
          const url = targetUrl
            ? `${base}${base.includes('?') ? '&' : '?'}url=${encodeURIComponent(targetUrl)}`
            : base;
          window.open(url, '_blank', 'noopener,noreferrer');
        });
      });
    } catch (err) {
      console.warn('[media-tab] loadPlatformStatus failed:', err);
    }
  }

  // Persists the download directory to Settings (MEDIA_DOWNLOAD_DIR).
  async saveDownloadDir() {
    const value = String(this.downloadDirInput?.value || '').trim();
    if (!this.downloadDirSaveBtn) return;
    this.downloadDirSaveBtn.textContent = '保存中…';
    this.downloadDirSaveBtn.disabled = true;
    try {
      const resp = await fetch('/settings', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { MEDIA_DOWNLOAD_DIR: value } })
      });
      const d = await resp.json().catch(() => ({}));
      if (resp.ok) {
        this.notify(value ? `下载目录已设置：${value}（重启服务后生效）` : '已恢复默认下载目录（outputs）', 'success');
      } else {
        this.notify(d?.error?.message || `HTTP ${resp.status}`, 'error');
      }
    } catch (err) {
      this.notify(`保存失败：${err.message}`, 'error');
    } finally {
      this.downloadDirSaveBtn.textContent = '保存';
      this.downloadDirSaveBtn.disabled = false;
    }
  }

  // ------------------------------------------------------------------
  // Output format selects (mirrors /api/formats; original = no conversion)
  // ------------------------------------------------------------------

  async loadOutputFormats() {
    try {
      const r = await fetch('/api/formats');
      const d = await r.json();
      const formats = (d.formats || []).filter((f) => !f.hidden && f.type === 'audio');
      if (!this.formatSelect) return;
      this.formatSelect.innerHTML = '';
      for (const f of formats) {
        const opt = document.createElement('option');
        opt.value = f.format;
        opt.textContent = f.format === 'original' ? 'ORIGINAL（不转换）' : f.format.toUpperCase();
        this.formatSelect.appendChild(opt);
      }
      const preferred = formats.find((f) => f.format === 'mp3') || formats[0];
      if (preferred) this.formatSelect.value = preferred.format;
      this.formats = formats;
      this.syncBitrateOptions();
    } catch (err) {
      console.warn('[media-tab] loadOutputFormats failed:', err);
    }
  }

  syncBitrateOptions() {
    const fmt = this.formats?.find((f) => f.format === this.formatSelect?.value);
    if (!this.bitrateSelect || !fmt) return;
    const isOriginal = fmt.format === 'original';
    if (this.bitrateGroup) this.bitrateGroup.style.display = isOriginal ? 'none' : '';
    this.bitrateSelect.innerHTML = '';
    for (const br of fmt.bitrates || ['auto']) {
      const opt = document.createElement('option');
      opt.value = br;
      opt.textContent = br === 'lossless' ? '无损' : br;
      this.bitrateSelect.appendChild(opt);
    }
    this.bitrateSelect.value = fmt.defaultBitrate || (fmt.bitrates || ['auto'])[0];
  }

  // ------------------------------------------------------------------
  // Results list
  // ------------------------------------------------------------------

  setResults(items, title, metaText) {
    this.results = Array.isArray(items) ? items : [];
    this.resultsTitle.textContent = title;
    this.resultsMeta.textContent = metaText || '';
    if (this.resultsCard) this.resultsCard.style.display = '';
    if (this.selectAll) this.selectAll.checked = this.results.length > 0;
    this.renderResults();
    this.resultsCard?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  renderResults() {
    const list = this.resultsList;
    if (!list) return;
    list.innerHTML = '';
    this.results.forEach((item, idx) => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 10px;border:1px solid rgba(128,128,128,.2);border-radius:6px;cursor:pointer;';
      const duration = item.durationSec ? this.fmtDuration(item.durationSec) : '';
      const platformTag = this.platformTag(item.platform);
      row.innerHTML = `
        <input type="checkbox" class="media-item-check" data-idx="${idx}" checked>
        <span class="media-item-platform" style="font-size:.8em;opacity:.75;min-width:56px;">${platformTag}</span>
        <span class="media-item-title" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
        <span class="media-item-artist" style="font-size:.82em;opacity:.75;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
        ${duration ? `<span style="font-size:.8em;opacity:.6;">${duration}</span>` : ''}`;
      row.querySelector('.media-item-title').textContent = item.title || '';
      row.querySelector('.media-item-artist').textContent = item.artist || '';
      row.querySelector('.media-item-check').addEventListener('change', () => this.updateSelectedCount());
      list.appendChild(row);
    });
    this.updateSelectedCount();
  }

  platformTag(platform) {
    return {
      bilibili: '📺 B站', bililive: '🔴 直播', qqmusic: '🐧 QQ', netease: '🎵 网易',
      neteaselive: '📻 电台', youtube: '▶️ YouTube', netease_redirect: '🎵 网易'
    }[platform] || platform;
  }

  fmtDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  updateSelectedCount() {
    const n = this.resultsList?.querySelectorAll('.media-item-check:checked').length || 0;
    if (this.downloadBtn) {
      this.downloadBtn.textContent = n > 0 ? `⬇️ 下载选中（${n}）` : '⬇️ 下载选中';
      this.downloadBtn.disabled = n === 0;
    }
  }

  setBusy(btn, busy, busyText) {
    if (!btn) return;
    if (busy) {
      btn.dataset.label = btn.textContent;
      btn.textContent = busyText || '…处理中';
      btn.disabled = true;
    } else {
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
      btn.disabled = false;
    }
  }

  // ------------------------------------------------------------------
  // Bilibili URL resolve
  // ------------------------------------------------------------------

  async resolveBilibili() {
    const url = String(this.biliUrlInput?.value || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      this.notify('请输入 Bilibili 视频 / 合集 或 网易云歌单链接', 'error');
      return;
    }
    this.setBusy(this.biliResolveBtn, true, '解析中…');
    try {
      const r = await fetch(`/api/media/resolve?url=${encodeURIComponent(url)}`);
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
      const modeLabel = d.mode === 'list' ? '合集 / 列表' : '单视频';
      this.setResults(d.items, `📺 ${d.title || 'Bilibili'}（${modeLabel} · ${d.totalCount} 项）`, `来源：${url}`);
      if (this.biliModeSelect?.value === 'single' && d.mode === 'list') {
        this.notify(`该链接是合集（${d.totalCount} 个分P），已列出全部；如只需单个分P，请保留前 1 项勾选`, 'info');
      }
    } catch (err) {
      this.notify(`解析失败：${err.message}`, 'error');
    } finally {
      this.setBusy(this.biliResolveBtn, false);
    }
  }

  // ------------------------------------------------------------------
  // Platform search
  // ------------------------------------------------------------------

  async runSearch() {
    const keyword = String(this.searchInput?.value || '').trim();
    if (!keyword) {
      this.notify('请输入搜索关键词', 'error');
      return;
    }
    const platforms = [...document.querySelectorAll('.media-search-platform:checked')]
      .map((c) => c.value)
      .filter(Boolean);
    if (!platforms.length) {
      this.notify('请至少选择一个搜索平台', 'error');
      return;
    }
    this.setBusy(this.searchBtn, true, '搜索中…');
    const merged = [];
    const failures = [];
    await Promise.all(platforms.map(async (platform) => {
      try {
        const r = await fetch(`/api/media/search?platform=${encodeURIComponent(platform)}&keyword=${encodeURIComponent(keyword)}&limit=20`);
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
        for (const it of d.items || []) merged.push(it);
      } catch (err) {
        failures.push(`${platform}: ${err.message}`);
      }
    }));
    this.setBusy(this.searchBtn, false);
    if (failures.length) this.notify(`部分平台搜索失败 → ${failures.join('；')}`, 'error');
    if (!merged.length && failures.length === platforms.length) return;
    this.setResults(merged, `🔍 “${keyword}” 搜索结果`, `共 ${merged.length} 条${failures.length ? `（${failures.length} 个平台失败）` : ''}`);
  }

  // ------------------------------------------------------------------
  // Batch download
  // ------------------------------------------------------------------

  async downloadSelected() {
    if (this.submitting) return;
    const checked = [...(this.resultsList?.querySelectorAll('.media-item-check:checked') || [])];
    if (!checked.length) {
      this.notify('请先勾选要下载的条目', 'error');
      return;
    }
    const format = this.formatSelect?.value || 'mp3';
    const isOriginal = format === 'original';
    const bitrate = isOriginal ? 'auto' : (this.bitrateSelect?.value || '192k');
    const items = checked.map((c) => this.results[Number(c.dataset.idx)]).filter(Boolean);

    this.submitting = true;
    this.setBusy(this.downloadBtn, true, '提交中…');
    let ok = 0;
    const failed = [];
    for (const item of items) {
      try {
        const resp = await fetch('/api/jobs', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: item.url,
            format,
            bitrate,
            isPlaylist: false,
            sampleRate: 48000,
            autoCreateZip: false
          })
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && (data.id || data.ok)) {
          ok += 1;
        } else {
          failed.push(`${item.title}: ${data?.error?.message || `HTTP ${resp.status}`}`);
        }
      } catch (err) {
        failed.push(`${item.title}: ${err.message}`);
      }
    }
    this.submitting = false;
    this.setBusy(this.downloadBtn, false);

    if (ok > 0) this.notify(`已提交 ${ok} 个下载任务（${isOriginal ? '不转换' : format + ' ' + bitrate}），进度见 Jobs 面板`, 'success');
    if (failed.length) this.notify(`提交失败 ${failed.length} 条 → ${failed.slice(0, 2).join('；')}${failed.length > 2 ? ' …' : ''}`, 'error');
    if (ok > 0) {
      try { this.app?.jobManager?.jobsPanel?.open?.(); } catch {}
    }
  }
}

export default MediaDownloadTab;
