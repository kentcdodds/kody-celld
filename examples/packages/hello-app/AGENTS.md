# hello-app

This package is served as a package app (`kody.app.entry` in `package.json`); `packageContext` is only set inside app requests, so `index.js` must not rely on it. Keep the app a plain `fetch` handler and do not read Kody credentials from it: the host strips them.
