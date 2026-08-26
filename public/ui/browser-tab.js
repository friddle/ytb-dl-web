(function () {
  const btn = document.getElementById('browserTabBtn');
  const overlay = document.getElementById('browserTabOverlay');
  const frame = document.getElementById('browserTabFrame');
  const closeBtn = document.getElementById('browserTabClose');
  if (!btn || !overlay || !frame || !closeBtn) return;

  let open = false;

  async function load() {
    try {
      const r = await fetch('/api/browser/url');
      const data = await r.json();
      if (data && data.enabled && data.url) {
        btn.style.display = '';
        btn.dataset.browserUrl = data.url;
      }
    } catch (e) {}
  }

  btn.addEventListener('click', () => {
    open = !open;
    if (open) {
      if (frame.src === 'about:blank') frame.src = btn.dataset.browserUrl || '';
      overlay.style.display = 'flex';
    } else {
      overlay.style.display = 'none';
    }
  });

  closeBtn.addEventListener('click', () => {
    open = false;
    overlay.style.display = 'none';
  });

  load();
})();