# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-07

### Added

- **`browser_console` tool** — reads what the page itself said: `console.log/info/warn/error/debug`,
  uncaught page errors, and failed network requests. Captured continuously per tab with no setup.
  Filters: `level` (`all`/`error`/`warning`/`info`/`log`/`debug`/`network`), `limit`, `since`
  (epoch-ms, for polling without re-reading the world), `pageId` (including a recently closed tab).
- **`browser_logs` tool** — tails the daemon's own log (startup, crashes, recoveries, RPC errors)
  with `level`, `grep` and `limit` filters. Previously the only way to see daemon activity was to
  know the log file path and shell out to read it.
- **`diagnose`** now returns `consoleSummary` (totals for errors / warnings / failed requests, and a
  per-type breakdown) and `logFile`, so a single call tells you whether to go look at the console.
- **`health_check` RPC** — forces a health-check cycle instead of waiting for the throttled one.
- **First automated test suite** (the package previously had none): 3 suites / 159 assertions
  covering the daemon's automation surface, the diagnostics capture, and the client tool layer.
  Tests drive the real daemon over its real Unix socket and load the real `index.ts` under tsx —
  no mock of the thing under test. `npm test`, or `bash test/run-all.sh`.
- Config knobs `healthCheckIntervalMs` and `blankPageThreshold` (defaults unchanged: 30s / 3).

### Fixed

- **Page console output was never captured at all.** There was no `page.on("console")` handler
  anywhere in the daemon, so `console.log/warn/error` from a page reached neither the agent nor the
  log file. A page that looked fine in a screenshot could be entirely broken with nothing to show it.
- **Uncaught page errors were captured inconsistently.** `pageerror` listeners were attached by hand
  at four separate page-creation sites; `tabs create` attached none, so JS errors in a newly opened
  tab were invisible. All four paths now share one `attachPageListeners()` helper, and a test
  regression-guards each path.
- **Blank-page "recreate storm".** A tab sitting on `about:blank` or `chrome-error://` (a legitimate
  idle tab, or the aftermath of a failed navigation) was classified as corruption and recreated
  every ~30s, forever. One long-lived daemon's log showed 1,200+ such recreations. These states are
  now recognised as intentional and left alone; genuinely blanked pages are still recovered.
- **`navigate` used a stale page reference after recovery.** Following `recreateActivePage()` it
  called `goto()`/`isBlankPage()` on the page object it had just closed (two call sites).
- **`init` race.** `initBrowser()` published `browser` before creating the initial page, so a second
  concurrent `init` returned `{ ok: true, pageId: null }` — success, with nothing to act on.
- **`tabs list` reported a fake title.** Every tab's title was the literal string `"..."`
  (`p.url() ? "..." : "(new tab)"` — always the first branch), which an agent would read as a real
  page title. It now returns the actual document title.
- **Closing a tab focused the oldest tab ever created** (`getPageIds()[0]`) rather than the adjacent
  one, silently changing which document subsequent calls acted on.
- **`reload` reported no HTTP status**, so a reload that came back 500 looked identical to a clean one.
- **`/browser profile list` always reported "(no profiles)".** It called `readFile()` on a directory;
  the resulting `EISDIR` was swallowed by a `.catch(() => [])`. Now uses `readdir()`.
- **`npm run check` could not fail.** It passed `--noCheck`, which skips type errors entirely. With
  that removed, 8 pre-existing type errors surfaced and are fixed — 6 of them `required:` properties
  on `registerTool`, which pi's `ToolDefinition` does not have and therefore silently ignored.
- **devDependencies were pinned to pi 0.83.0** while the host is on 1.0.x, so typechecking validated
  against an API nobody runs anymore. Now `^1.0.4`, and verified clean against the current host.
- **`release.sh` published without running the tests**, and its success message printed
  `npm:pi-vigilant@<version>` — the wrong package, copy-pasted.

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
