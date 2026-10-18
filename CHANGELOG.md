# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-10-18

### Fixed

- **`files` shipped `src/daemon.ts` by name, so 0.2.1 was published broken.** When
  `src/daemon.ts` gained `import "./screenshot-dir.ts"`, nothing complained: typecheck reads
  the working tree, the suite runs from the working tree, and `npm publish` succeeded — but
  the packed artifact had no `src/screenshot-dir.ts`, so the daemon could not start on any
  machine that installed 0.2.1. A whitelist that has to be updated for every new file fails
  silently, and only a clean-room install could see it. `files` now ships `src/` as a
  directory.
  - **0.2.1 is deprecated on npm** (`missing src/screenshot-dir.ts — the daemon cannot
    start`); install 0.2.2 or later.

### Tests

- **`test/test-packaging.mjs` — 10 checks** that inspect the artifact npm would actually
  publish (`npm pack --dry-run --json`) rather than the working tree: the entry points ship,
  **every relative import in a shipped file resolves to a file that also ships**, `src/` is
  shipped as a directory rather than enumerated per file, and the module that broke 0.2.1 is
  present. Verified as a real guard: with the old enumerated `files` list restored, 4 checks
  fail naming `./screenshot-dir.ts`; with the fix, 10/10.
- Suite now runs 5 suites / 189 checks, all green; `npm run check` clean.

### Tools

- `scripts/release.sh` gained the publish-landed gate (ported from pi-vigilant, where the
  phantom release was first seen): it polls the registry until the version is genuinely
  installable — packument **and** a fetchable tarball — and exits non-zero otherwise. It ran
  immediately on 0.2.1, caught npm holding the version in its staging queue, and refused to
  print the success banner.

## [0.2.1] - 2026-10-18

### Fixed

- **Screenshots no longer die with `EACCES` on a shared machine.** The Unix screenshot
  directory was the fixed path `/tmp/pi-aia-browser-screenshots`. `/tmp` is world
  writable, so the first user to create that directory owns it — and every other user's
  daemon passed `mkdir({ recursive: true })` (an existing directory satisfies it, and
  reports nothing wrong) and then failed on the first screenshot when the file was
  actually opened. The failure surfaced far from its cause and took the whole client
  suite down: on this box the directory belonged to another account (`infra`, mode 775)
  and `test-client.mjs` could not pass at all.
  - The default is now per-user — `/tmp/pi-aia-browser-screenshots-<uid>` — created
    `0700`, so it cannot be pre-empted by another account or used as a squatting/symlink
    target.
  - If even that candidate is not writable, the daemon falls back to a private `mkdtemp`
    directory (and then to `~/.pi/browser/screenshots`) and keeps working, instead of
    accepting a directory it cannot write into and failing later.
  - `PI_AIA_BROWSER_SCREENSHOT_DIR` still overrides verbatim.
  - Extracted to `src/screenshot-dir.ts` so it is testable without booting Playwright.

### Tests

- **`test/test-screenshot-dir.mjs` — 15 checks**, covering the per-user default, its `0700`
  mode, the operator override, the no-`getuid` path, and the hostile case: the candidate
  directory exists but is not writable. The fixture asserts it is genuinely unwritable,
  so the section cannot pass vacuously, and the check that matters is that a file can
  actually be written to the returned path — the call that used to throw. Verified as a
  real guard: with the legacy fixed-name behaviour restored, 8 of the 15 fail; with the
  fix, 15/15.
- Suite now runs 4 suites / 179 checks, all green; `npm run check` clean.

### Tools

- **`scripts/release.sh` now verifies the publish landed.** `npm publish` exits 0 when npm
  merely *accepts* the upload, and npm can hold a version in its staging queue with the
  packument listing it while the tarball 404s — the same failure that made pi-vigilant 0.8.0
  print "✅ Released" while `npm install` failed with `ETARGET`. The script now polls the
  registry until the version is genuinely installable (metadata **and** a fetchable
  tarball) and exits non-zero if it never becomes so. A tag and a commit are not a release.

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

- **`browser_init` could report success with no tab to use.** It only pinged the daemon — it never
  asked for a page — and `initBrowser()` treated "a browser object exists" as ready. After an idle
  shutdown, or once every tab had been closed, it returned `Pages: 0 / Active tab: none` while
  claiming the daemon was running, and the next call failed with `no-active-page`. `browser_init`
  now calls `init`, and `init` guarantees a tab.
- **Page creation was copy-pasted across four sites.** Extracted a single `createPage()` helper; this
  is the same duplication that let `tabs create` miss its listeners (below).
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
