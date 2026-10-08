'use strict';
const { origin } = require('./browser-sessions.cjs');
function createFactory({ BrowserWindow, session }) {
  return async ({ id, url, onClosed, allowNavigation }) => {
    const isolated = session.fromPartition('hyphen-browser-' + id, { cache: false });
    isolated.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    const window = new BrowserWindow({
      title: 'Hyphen browser · You control this session',
      width: 1100,
      height: 780,
      show: true,
      webPreferences: {
        session: isolated,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    const web = window.webContents;
    web.setWindowOpenHandler(() => ({ action: 'deny' }));
    const navigation = (event, target) => {
      try {
        origin(target);
        if (allowNavigation && !allowNavigation(target)) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    };
    web.on('will-navigate', navigation);
    web.on('will-redirect', navigation);
    isolated.on('will-download', (event) => event.preventDefault());
    window.once('closed', onClosed);
    try {
      await window.loadURL(url);
    } catch (error) {
      window.close();
      throw error;
    }
    return {
      url: () => web.getURL(),
      show: () => {
        window.show();
        window.focus();
      },
      hide: () => window.hide(),
      close: () => {
        if (!window.isDestroyed()) window.close();
      },
      navigate: (target) => web.loadURL(target),
      read: () => web.executeJavaScript('document.body?.innerText || ""'),
      async stop() {
        if (web.isDestroyed()) return true;
        web.stop();
        const until = Date.now() + 2000;
        while (web.isLoading() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
        return !web.isLoading();
      },
      cookies: (current) => isolated.cookies.get({ url: current }),
      async clearLogin() {
        // Stop the original page before clearing its partition: page scripts
        // must not repopulate storage while removal is in flight.
        if (!window.isDestroyed()) window.destroy();
        await isolated.closeAllConnections();
        await isolated.clearStorageData();
        await isolated.clearCache();
        await isolated.clearAuthCache();
        if ((await isolated.cookies.get({})).length)
          throw new Error('Private-session cookie removal was not confirmed.');
        return true;
      },
      async restoreCookies(current, cookies) {
        const host = new URL(current).hostname;
        for (const c of cookies) {
          const domain = String(c.domain || '').replace(/^\./, '');
          if (domain !== host && !host.endsWith('.' + domain))
            throw new Error('Saved cookie is outside the exact destination.');
          const allowed = [
            'name',
            'value',
            'domain',
            'path',
            'secure',
            'httpOnly',
            'expirationDate',
            'sameSite',
          ];
          const row = Object.fromEntries(
            allowed.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]),
          );
          await isolated.cookies.set({ url: current, ...row });
        }
      },
    };
  };
}
module.exports = { createFactory };
