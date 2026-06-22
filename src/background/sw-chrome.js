// Chromium MV3 service-worker entry point.
// Loads the cross-browser polyfill (so `browser.*` works), then the shared
// background logic. Firefox instead uses an event page with `background.scripts`
// (see manifest.json); the same background.js runs in both.
importScripts("/vendor/browser-polyfill.min.js", "/src/background/background.js");
