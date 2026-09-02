import { settingsManager } from './SettingsManager.js';
import { jobsPanelManager } from './JobsPanelManager.js';
import { versionManager } from './VersionManager.js';
import { HomeApp } from './HomeApp.js';

async function waitForRuntimeBinariesReady() {
    const overlay = document.getElementById('binaryStartupOverlay');
    if (!overlay) return;

    const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

    while (true) {
        try {
            const response = await fetch('/api/binaries/status', { cache: 'no-store' });
            if (response.ok) {
                const status = await response.json();
                if (!status?.active) return;
            }
        } catch (error) {
            console.warn('Runtime binary readiness check failed:', error);
        }
        await sleep(500);
    }
}

function hideRuntimeBinariesOverlay() {
    const overlay = document.getElementById('binaryStartupOverlay');
    if (!overlay) return;
    overlay.classList.add('is-ready');
    overlay.setAttribute('aria-busy', 'false');
}

if (typeof window !== 'undefined' && window.electronAPI?.updateLanguage) {
  document.addEventListener('i18n:applied', (event) => {
    const lang = event?.detail?.lang;
    if (lang) window.electronAPI.updateLanguage(lang).catch?.(() => {});
  });
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        await window.i18nInit();
    } catch (error) {
        console.error('i18n initialization failed:', error);
    }

    if (window.i18n?.apply) {
        window.i18n.apply(document.body);
    }

    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) loadingScreen.style.display = 'none';

    await waitForRuntimeBinariesReady();

    await settingsManager.initialize();
    await versionManager.initialize();

    jobsPanelManager.initialize();
    window.jobsPanelManager = jobsPanelManager;

    window.versionManager = versionManager;
    window.settingsManager = settingsManager;

    const homeApp = new HomeApp();
    homeApp.initialize();
    window.homeApp = homeApp;

    hideRuntimeBinariesOverlay();
});
