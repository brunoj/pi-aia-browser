# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-08-14

### Fixed

- **Install failed with `MODULE_NOT_FOUND` on `pi install npm:pi-aia-browser`.** The published tarball's `files` list omitted `scripts/`, but `package.json` declared `"postinstall": "node scripts/install-browser.mjs"`. npm therefore ran a script that did not exist in the package, aborting the install. `scripts/install-browser.mjs` is now included in `files`.
- **Postinstall no longer aborts the install when Playwright is not resolvable yet.** It now warns and exits successfully; Chromium is installed on first browser use instead.

## [0.1.0] - 2026-08-14

### Added

- Initial public release of pi-aia-browser (published from the local pi-browser extension).
- Persistent Playwright browser daemon with Unix-socket JSON-RPC (survives pi restarts, auto-shutdown after 60 min idle).
- 16 browser tools: init, navigate, click, type, screenshot, dom, js, scroll, wait, tabs, back, forward, reload, cookies, diagnose, close.
- Multi-tab management, element selectors (CSS/text/XPath), full-page and element screenshots.
- User profiles with session persistence (cookies saved per profile, e.g. for LinkedIn).
- Automatic Chromium installation on install (postinstall script, idempotent).
- Daemon health diagnostics and auto-recovery (blank-page detection, crash respawn).
- Renamed socket/log paths to pi-aia-browser namespaces (no conflict with any local pi-browser install).
