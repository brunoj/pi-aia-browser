# pi-aia-browser

Full browser automation for [pi](https://pi.dev): a persistent Playwright daemon with multi-tab support, screenshots, JS injection, user profiles, and cookies — as 16 `browser_*` tools.

**Chromium is installed automatically on install** (postinstall script). Playwright is a regular dependency, so everything works right after `pi install`.

> Originally developed locally as the `pi-browser` extension; published as **pi-aia-browser** (the npm name `pi-browser` was already taken by a different, simpler package).

## Install

```bash
pi install npm:pi-aia-browser
```

The postinstall script downloads Chromium (idempotent — skips if already present). If it fails (e.g. missing system libraries), run manually:

```bash
# inside the installed package dir, or:
npx playwright install chromium
# Linux servers often also need:
npx playwright install --with-deps chromium
```

Then restart pi or run `/reload`.

## Tools

| Tool | Purpose |
|---|---|
| `browser_init` | Start/ensure the browser daemon (auto-starts if not running) |
| `browser_navigate` | Go to a URL |
| `browser_click` | Click an element (CSS, text, XPath) |
| `browser_type` | Type into an input |
| `browser_screenshot` | Screenshot page/element |
| `browser_dom` | Inspect DOM (html/text/attributes/computed) |
| `browser_js` | Execute JavaScript in the page |
| `browser_scroll` | Scroll page/container |
| `browser_wait` | Wait for timeout/selector/navigation/network/condition |
| `browser_tabs` | List/switch/create/close tabs |
| `browser_back` / `browser_forward` | History navigation |
| `browser_reload` | Reload page |
| `browser_cookies` | Get/set/clear cookies |
| `browser_diagnose` | Daemon health, memory, page state |
| `browser_close` | Shut down the daemon |

## How it works

- **Client extension** (`index.ts`) — registers the tools, communicates with the daemon over a Unix socket (`~/.pi/run/aia-browser.sock`), auto-spawns the daemon on first use.
- **Daemon** (`src/daemon.ts`) — persistent Playwright process that survives pi restarts; manages browser contexts, tabs, profiles, screenshots, and auto-shuts down after 60 min idle.
- **Profiles** — saved sessions in `~/.pi/browser/profiles` (login persistence, e.g. LinkedIn).
- **Logs** — `~/.pi/agent/logs/pi-aia-browser/daemon.log`.

## Use cases

- Testing web interfaces end-to-end (mandatory per the AIA ASF workflow — real user experience, not just curl)
- LinkedIn automation (posting, messaging, research)
- Any site that needs login/session persistence
- Debugging visual issues with screenshots

## Development

```bash
npm install          # installs deps + Chromium (postinstall)
npm run check        # typecheck
npm run release patch|minor|major   # test → version → CHANGELOG → tag → push
```

## License

MIT © Bruno Jakic, Ai Applied
