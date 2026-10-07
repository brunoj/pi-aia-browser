/**
 * pi-aia-browser daemon — persistent Playwright process that stays alive
 * across pi sessions. Communicates via Unix socket (JSON-RPC).
 *
 * Designed to be spawned as a detached child process so it survives
 * pi restarts. Auto-shuts down after idle timeout.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createServer, type Socket } from "node:net";
import { mkdir, unlink, access, writeFile, appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ─── Config ───────────────────────────────────────────────────────────────

const isWin = process.platform === "win32";
const PI_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi");
const RUN_DIR = join(PI_DIR, "run");
// Windows uses named pipes (\\.\pipe\name), Unix uses socket files
const SOCKET_PATH = isWin
  ? join("\\\\?\\pipe", "pi-aia-browser")
  : join(RUN_DIR, "aia-browser.sock");
const LOG_DIR = join(PI_DIR, "agent", "logs", "pi-aia-browser");
const LOG_FILE = join(LOG_DIR, "daemon.log");
const SCREENSHOT_DIR = process.env.PI_AIA_BROWSER_SCREENSHOT_DIR
  || (isWin ? join(PI_DIR, "browser", "screenshots") : "/tmp/pi-aia-browser-screenshots");
const CONFIG_PATH = join(PI_DIR, "browser", "config.json");
const PROFILES_DIR = join(PI_DIR, "browser", "profiles");

const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes (was 30 — too aggressive)
const NAVIGATION_TIMEOUT_MS = 60000; // 60s (was 30 — too short for heavy SPAs)
const MAX_TABS = 10;
const BLANK_PAGE_THRESHOLD = 3; // consecutive blank page detections before recovery
const HEALTH_CHECK_THROTTLE_MS = 30000; // min gap between health checks
// Config overridable (config.healthCheckIntervalMs / config.blankPageThreshold)
// — mainly so tests can exercise the health check without waiting 30s a cycle.
function healthCheckThrottleMs(): number {
  const v = config?.healthCheckIntervalMs;
  return typeof v === "number" && v >= 0 ? v : HEALTH_CHECK_THROTTLE_MS;
}
function blankPageThreshold(): number {
  const v = config?.blankPageThreshold;
  return typeof v === "number" && v > 0 ? v : BLANK_PAGE_THRESHOLD;
}

// ─── State ────────────────────────────────────────────────────────────────

let browser: Browser | null = null;
let context: BrowserContext | null = null;
const pages = new Map<string, Page>();
let activePageId: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let server: ReturnType<typeof createServer> | null = null;
let startupTime = Date.now();
let config: any = {};
let consecutiveBlankPages = 0;
let lastHealthCheck = Date.now();
// Guards against concurrent initBrowser() calls (client browser_init racing
// the daemon's own autoInit) launching two Chromium processes.
let initPromise: Promise<void> | null = null;

// ─── Per-page diagnostics (console + page errors + failed requests) ───────
// Bounded ring buffers so a chatty page can't grow memory unboundedly.
// Keyed by pageId; entries persist briefly after a page closes/recreates so
// the agent can still ask "what just happened" right after a crash/recreate.

const CONSOLE_BUFFER_MAX = 500;
const DIAGNOSTICS_RETENTION_MS = 10 * 60 * 1000; // keep closed-page buffers 10 min

interface ConsoleEntry {
  t: number;
  type: string; // console message type: log, error, warning, info, debug...
  text: string;
  pageId: string;
}

const consoleBuffers = new Map<string, ConsoleEntry[]>(); // pageId -> entries
const bufferRetiredAt = new Map<string, number>(); // pageId -> close timestamp (for GC)

function pushConsoleEntry(pageId: string, entry: ConsoleEntry) {
  let buf = consoleBuffers.get(pageId);
  if (!buf) {
    buf = [];
    consoleBuffers.set(pageId, buf);
  }
  buf.push(entry);
  if (buf.length > CONSOLE_BUFFER_MAX) buf.splice(0, buf.length - CONSOLE_BUFFER_MAX);
}

function gcConsoleBuffers() {
  const now = Date.now();
  for (const [pageId, retiredAt] of bufferRetiredAt) {
    if (!pages.has(pageId) && now - retiredAt > DIAGNOSTICS_RETENTION_MS) {
      consoleBuffers.delete(pageId);
      bufferRetiredAt.delete(pageId);
    }
  }
}

/**
 * Attach the full diagnostic listener set (close, pageerror, console,
 * requestfailed) to a newly created page. MUST be called at every page
 * creation site — missing this silently drops console/pageerror capture
 * for that page (this was a real bug: the "tabs create" RPC and the
 * navigation-recovery path each had their own hand-rolled subset).
 */
function attachPageListeners(page: Page, pageId: string) {
  page.on("close", () => {
    // Capture order BEFORE deleting so we can focus the *adjacent* tab.
    // The old code used getPageIds()[0], which threw the user back to the
    // oldest tab ever created — surprising, and it silently changed which
    // document subsequent calls acted on.
    const order = Array.from(pages.keys());
    const idx = order.indexOf(pageId);
    pages.delete(pageId);
    bufferRetiredAt.set(pageId, Date.now());
    if (activePageId === pageId) {
      const remaining = order.filter((id) => id !== pageId);
      activePageId = remaining.length > 0
        ? remaining[Math.max(0, Math.min(idx, remaining.length - 1))]
        : null;
    }
  });

  page.on("pageerror", (err) => {
    log("error", "page-error", { pageId, error: err.message });
    pushConsoleEntry(pageId, { t: Date.now(), type: "pageerror", text: err.message, pageId });
  });

  page.on("console", (msg) => {
    const type = msg.type();
    pushConsoleEntry(pageId, { t: Date.now(), type, text: msg.text(), pageId });
    if (type === "error") {
      log("warn", "console-error", { pageId, text: msg.text() });
    }
  });

  page.on("requestfailed", (req) => {
    const failure = req.failure();
    pushConsoleEntry(pageId, {
      t: Date.now(),
      type: "requestfailed",
      text: `${req.method()} ${req.url()} — ${failure?.errorText ?? "unknown error"}`,
      pageId,
    });
  });
}

// ─── Logging ──────────────────────────────────────────────────────────────

/**
 * Read the tail of the daemon's own log file so the agent can inspect what
 * the daemon actually did (timeouts, RPC errors, health-check recoveries)
 * without knowing where the file lives or shelling out to tail/grep.
 */
async function tailDaemonLog(
  maxLines: number,
  level?: string,
  grep?: string,
): Promise<Array<{ t: string; level: string; msg: string; data?: any }>> {
  let raw: string;
  try {
    raw = await readFile(LOG_FILE, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const tail = lines.slice(-Math.max(maxLines, 1));
  const out: Array<{ t: string; level: string; msg: string; data?: any }> = [];
  for (const line of tail) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (level && level !== "all" && entry.level !== level) continue;
    if (grep && !line.toLowerCase().includes(grep.toLowerCase())) continue;
    out.push(entry);
  }
  return out;
}

async function log(level: string, msg: string, data?: any) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...(data ? { data } : {}),
  }) + "\n";
  try {
    await appendFile(LOG_FILE, line);
  } catch {}
  if (level === "error" || level === "fatal") {
    process.stderr.write(line);
  }
}

function logSync(level: string, msg: string, data?: any) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...(data ? { data } : {}),
  }) + "\n";
  try {
    require("fs").appendFileSync(LOG_FILE, line);
  } catch {}
}

// ─── Config ────────────────────────────────────────────────────────────────

async function loadConfig(): Promise<any> {
  try {
    const data = await import("node:fs/promises").then(fs => fs.readFile(CONFIG_PATH, "utf-8"));
    return JSON.parse(data);
  } catch {
    return {};
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getActivePage(): Page | null {
  if (!activePageId) return null;
  return pages.get(activePageId) ?? null;
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  const timeout = config.idleTimeoutMinutes ? config.idleTimeoutMinutes * 60 * 1000 : DEFAULT_IDLE_TIMEOUT_MS;
  if (timeout > 0) {
    idleTimer = setTimeout(() => {
      log("info", "idle-timeout-shutdown", { idleMinutes: config.idleTimeoutMinutes ?? 60 });
      shutdown();
    }, timeout);
  }
}

function getPageIds(): string[] {
  return Array.from(pages.keys());
}

function generatePageId(): string {
  return `page_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ─── Health Check ──────────────────────────────────────────────────────────

async function isBlankPage(page: Page): Promise<boolean> {
  try {
    const html = await page.evaluate(() => document.documentElement?.outerHTML || "");
    // Blank pages have only <head></head><body></body> or similar minimal structure
    const stripped = html.replace(/\s+/g, "");
    return stripped.length < 50 && !stripped.includes("<div");
  } catch {
    return false;
  }
}

/**
 * A page sitting on about:blank / chrome-error:// is NOT a corrupted page —
 * it is the expected state of an idle tab or of a navigation that failed for
 * a legitimate reason (server down, blocked URL, offline).
 *
 * Without this guard the health check recreated the page every 30s forever
 * (1,218 recreations / 6,116 log lines observed on one long-lived daemon),
 * which also threw away the page's diagnostic state and re-registered
 * listeners on a brand-new page each time.
 */
function isIntentionallyBlank(page: Page): boolean {
  let url = "";
  try {
    url = page.url();
  } catch {
    return false;
  }
  return url === "" || url === "about:blank" || url.startsWith("chrome-error://");
}

async function recreateActivePage() {
  if (!browser) return;
  
  const oldPageId = activePageId;
  const oldPage = oldPageId ? pages.get(oldPageId) : null;
  
  try {
    const newPage = context
      ? await context.newPage()
      : await browser.newPage();
    const pageId = generatePageId();
    pages.set(pageId, newPage);
    activePageId = pageId;

    attachPageListeners(newPage, pageId);

    // Close old page
    if (oldPage && oldPageId) {
      try {
        await oldPage.close();
      } catch {}
      pages.delete(oldPageId);
    }

    await log("info", "page-recreated", { oldPageId, newPageId: pageId });
  } catch (err: any) {
    await log("error", "page-recreate-failed", { error: err.message });
  }
}

async function performHealthCheck() {
  const now = Date.now();
  if (now - lastHealthCheck < healthCheckThrottleMs()) return; // throttled
  lastHealthCheck = now;

  try {
    const page = getActivePage();
    if (!page) return;

    if (page.isClosed()) {
      await log("warn", "health-check-page-closed", {});
      pages.delete(activePageId!);
      activePageId = null;
      // Create a new page
      const newPage = context
        ? await context.newPage()
        : await browser!.newPage();
      const pageId = generatePageId();
      pages.set(pageId, newPage);
      activePageId = pageId;
      attachPageListeners(newPage, pageId);
      await log("info", "health-check-recreated-closed-page", { pageId });
      return;
    }

    // Check if page is blank
    const blank = await isBlankPage(page);
    if (blank && isIntentionallyBlank(page)) {
      // Idle tab or failed-but-legitimate navigation — leave it alone.
      consecutiveBlankPages = 0;
    } else if (blank) {
      consecutiveBlankPages++;
      await log("warn", "health-check-blank-page", {
        consecutive: consecutiveBlankPages,
        url: page.url(),
      });
      if (consecutiveBlankPages >= blankPageThreshold()) {
        await log("warn", "health-check-recovering-blank-page", {});
        await recreateActivePage();
        consecutiveBlankPages = 0;
      }
    } else {
      consecutiveBlankPages = 0;
    }

    // Check if browser is still alive
    if (browser && !browser.isConnected()) {
      await log("warn", "health-check-browser-disconnected", {});
      // Browser disconnected — try to reconnect or restart
      try {
        await browser.close();
      } catch {}
      browser = null;
      context = null;
      pages.clear();
      activePageId = null;
      await initBrowser(config.activeProfile);
      await log("info", "health-check-browser-restarted", {});
    }
  } catch (err: any) {
    await log("error", "health-check-failed", { error: err.message });
  }
}

// ─── Browser Lifecycle ────────────────────────────────────────────────────

async function initBrowser(profileName?: string) {
  if (browser) {
    await log("warn", "init-browser-already-running");
    // Startup sets `browser` before the initial page exists, so a caller that
    // arrives mid-startup must still wait for the page — otherwise `init`
    // returns { ok: true, pageId: null } and the very next call fails with
    // "No active page" (this raced the client's browser_init against autoInit).
    if (initPromise) {
      try { await initPromise; } catch {}
    }
    return;
  }
  if (initPromise) {
    // Another init is in flight — join it rather than launching a second browser.
    try { await initPromise; } catch {}
    return;
  }
  initPromise = (async () => {
    const viewport = config.defaultViewport ?? { width: 1280, height: 800 };
  // Auto-detect headless mode:
  // - Windows: headful (headless Chromium has GPU/compositing issues)
  // - Linux/macOS: headful if DISPLAY/WAYLAND_DISPLAY is set, headless otherwise
  // - Config can always override via config.headless
  const hasDisplay = isWin
    ? true
    : !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const headless = config.headless !== undefined
    ? config.headless
    : !hasDisplay;

  let userDataDir: string | undefined;
  let profilePath: string | undefined;

  if (profileName && profileName !== "default") {
    profilePath = join(PROFILES_DIR, profileName);
    if (existsSync(profilePath)) {
      userDataDir = profilePath;
      await log("info", "using-profile", { profile: profileName, path: profilePath });
    } else {
      await log("warn", "profile-not-found-falling-back", { profile: profileName });
    }
  }

  const launchOptions: any = {
    headless,
    args: ["--no-sandbox"],
  };

  if (userDataDir) {
    launchOptions.args.push(`--user-data-dir=${userDataDir}`);
  }

  // Set LD_LIBRARY_PATH for systems missing browser deps (like this devbox)
  const libPath = "/tmp/chromelibs2/usr/lib/x86_64-linux-gnu";
  if (existsSync(libPath)) {
    process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
      ? `${libPath}:${process.env.LD_LIBRARY_PATH}`
      : libPath;
  }

  browser = await chromium.launch(launchOptions);

  // If we used --user-data-dir, the context is the default one
  if (!userDataDir) {
    context = await browser.newContext({
      viewport,
      userAgent: config.userAgent ?? undefined,
      locale: config.locale ?? "en-US",
      timezoneId: config.timezone ?? undefined,
      permissions: config.permissions ?? [],
    });
  }

  await log("info", "browser-launched", {
    headless,
    profile: profileName ?? "ephemeral",
    viewport,
  });

  // Create initial page
  const page = userDataDir
    ? await browser.newPage()
    : await (context!).newPage();

  const pageId = generatePageId();
  pages.set(pageId, page);
  activePageId = pageId;

  attachPageListeners(page, pageId);

  await log("info", "initial-page-created", { pageId });
  })();

  try {
    await initPromise;
  } catch (err) {
    // Let a later init retry instead of caching a permanently rejected promise.
    initPromise = null;
    throw err;
  }
}

async function shutdown() {
  await log("info", "shutting-down");
  try {
    for (const [id, page] of pages) {
      try { await page.close(); } catch {}
    }
    pages.clear();
    if (browser) {
      await browser.close();
      browser = null;
      context = null;
    }
  } catch (err: any) {
    await log("error", "shutdown-error", { error: err.message });
  }
  if (server) {
    server.close();
    server = null;
  }
  // Clean up socket file
  try { await unlink(SOCKET_PATH); } catch {}
  process.exit(0);
}

// ─── RPC Methods ──────────────────────────────────────────────────────────

async function handleRPC(method: string, params: any): Promise<any> {
  resetIdleTimer();

  // Run health check before every RPC call (lightweight, throttled)
  if (browser && method !== "ping" && method !== "diagnose" && method !== "shutdown") {
    performHealthCheck().catch(() => {});
  }

  switch (method) {
    // ── Lifecycle ──
    case "ping":
      return {
        pong: true,
        uptime: Date.now() - startupTime,
        pages: getPageIds().length,
        activePage: activePageId,
        browserAlive: browser !== null,
      };

    case "shutdown":
      await shutdown();
      return { ok: true };

    case "init":
      await initBrowser(params?.profile);
      return { ok: true, pageId: activePageId };

    // ── Navigation ──
    case "navigate": {
      let page = getActivePage();
      if (!page) throw rpcError("no-active-page", "No active page. Call init first.");
      const url = params.url;
      if (!url) throw rpcError("missing-url", "URL is required");
      validateUrl(url);

      const waitUntil = params.waitUntil ?? "domcontentloaded"; // changed from networkidle — faster, less timeout-prone
      const timeout = params.timeout ?? NAVIGATION_TIMEOUT_MS;

      let response;
      try {
        response = await page.goto(url, { waitUntil, timeout });
      } catch (err: any) {
        // Navigation timed out — page may be in broken state.
        // Try to recover by waiting for domcontentloaded, then continue.
        await log("warn", "navigation-timeout-recovering", {
          url,
          waitUntil,
          timeout,
          error: err.message,
        });
        try {
          await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
        } catch {
          // Page is truly stuck — recreate it
          await log("warn", "navigation-recovery-failed-recreating-page", { url });
          await recreateActivePage();
          // recreateActivePage() replaces the active page — the old `page`
          // handle is closed and unusable. Re-fetch it or every later call in
          // this handler would operate on a dead page.
          page = getActivePage() ?? page;
          response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
        }
      }

      // Check for blank page
      const isBlank = await isBlankPage(page);
      if (isBlank) {
        consecutiveBlankPages++;
        await log("warn", "blank-page-detected", {
          url,
          consecutive: consecutiveBlankPages,
          threshold: blankPageThreshold(),
        });
        if (consecutiveBlankPages >= blankPageThreshold()) {
          await log("warn", "blank-page-threshold-reached-recovering", { url });
          // First try navigating to feed to re-establish session context
          try {
            await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded", timeout: 30000 });
            await log("info", "blank-page-recovery-navigated-to-feed");
            // Then try the original URL
            response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
          } catch {
            // Feed navigation also failed — recreate the page
            await log("warn", "blank-page-feed-recovery-failed-recreating-page", { url });
            await recreateActivePage();
            page = getActivePage() ?? page;
            try {
              response = await page.goto(url, { waitUntil: "domcontentloaded", timeout });
            } catch {}
          }
          consecutiveBlankPages = 0;
        }
      } else {
        consecutiveBlankPages = 0;
      }

      return {
        url: page.url(),
        title: await page.title(),
        status: response?.status() ?? 0,
        ok: response?.ok() ?? false,
        timing: { waitUntil, timeout },
      };
    }

    // ── Click ──
    case "click": {
      const page = getActivePage();
      if (!page) throw rpcError("no-active-page", "No active page.");
      const el = await resolveElement(page, params);
      const btn = params.button ?? "left";
      const count = params.clickCount ?? 1;

      if (params.waitForNavigation) {
        await Promise.all([
          page.waitForNavigation({ timeout: params?.timeout ?? NAVIGATION_TIMEOUT_MS }),
          el.click({ button: btn, clickCount: count, modifiers: params.modifiers as any }),
        ]);
      } else {
        await el.click({ button: btn, clickCount: count, modifiers: params.modifiers as any });
      }

      return {
        clicked: true,
        url: page.url(),
        title: await page.title(),
        navigated: params.waitForNavigation ?? false,
      };
    }

    // ── Type ──
    case "type": {
      const page = getActivePage();
      if (!page) throw rpcError("no-active-page", "No active page.");
      const el = await resolveElement(page, params);

      if (params.clear) {
        await el.fill("");
      }
      if (params.value) {
        await el.fill(params.value);
      }
      if (params.submit) {
        await el.press("Enter");
      }

      return { typed: true, value: params.value };
    }

    // ── Select ──
    case "select": {
      const page = getActivePage();
      if (!page) throw rpcError("no-active-page", "No active page.");
      const el = await resolveElement(page, params);
      const values = await el.selectOption(params.value);
      return { selected: values };
    }

    // ── Hover ──
    case "hover": {
      const page = getActivePage();
      if (!page) throw rpcError("no-active-page", "No active page.");
      const el = await resolveElement(page, params);
      await el.hover();
      return { hovered: true };
    }

    // ── Scroll ──
    case "scroll": {
      const page = getActivePage();
      if (!page) throw rpcError("no-active-page", "No active page.");

      const dir = params.direction ?? "down";
      const amount = params.amount ?? 300;

      switch (dir) {
        case "up":
          await page.evaluate((y) => window.scrollBy(0, -y), amount);
          break;
        case "down":
          await page.evaluate((y) => window.scrollBy(0, y), amount);
          break;
        case "to":
          await page.evaluate(({ x, y }) => window.scrollTo(x ?? 0, y ?? 0), params);
          break;
        case "toElement": {
          if (!params.selector) throw rpcError("missing-selector", "selector required for toElement");
          const el = await page.$(params.selector);
          if (!el) throw rpcError("not-found", `Element "${params.selector}" not found`);
          await el.scrollIntoViewIfNeeded();
          break;
        }
        case "top":
          await page.evaluate(() => window.scrollTo(0, 0));
          break;
        case "bottom":
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          break;
        default:
          throw rpcError("invalid-direction", `Unknown direction: ${dir}`);
      }

      const scrollPos = await page.evaluate(() => ({
        x: window.scrollX,
        y: window.scrollY,
        maxY: document.body.scrollHeight - window.innerHeight,
      }));
      return { scrolled: true, direction: dir, position: scrollPos };
    }

    // ── Screenshot ──
    case "screenshot": {
      const page = getActivePage();
      if (!page) throw rpcError("no-active-page", "No active page.");

      await mkdir(SCREENSHOT_DIR, { recursive: true });
      const filename = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
      const filepath = join(SCREENSHOT_DIR, filename);

      const screenshotTimeout = params.timeout ?? 30000;

      try {
        if (params.selector) {
          const el = await page.$(params.selector);
          if (!el) throw rpcError("not-found", `Selector "${params.selector}" not found`);
          await el.screenshot({ path: filepath, timeout: screenshotTimeout });
        } else {
          await page.screenshot({
            path: filepath,
            fullPage: params.fullPage ?? false,
            timeout: screenshotTimeout,
          });
        }
      } catch (err: any) {
        await log("error", "screenshot-failed", { error: err.message, url: page.url(), fullPage: params.fullPage });
        // If fullPage times out, try viewport-only as fallback
        if (params.fullPage && (err.message?.includes("Timeout") || err.message?.includes("timeout"))) {
          await log("warn", "fullpage-screenshot-timeout-falling-back-to-viewport", { url: page.url() });
          await page.screenshot({ path: filepath, timeout: 30000 });
          return {
            filepath,
            url: page.url(),
            title: await page.title(),
            viewport: "viewport (fallback from full-page timeout)",
          };
        }
        throw err;
      }

      return {
        filepath,
        url: page.url(),
        title: await page.title(),
        viewport: params.fullPage ? "full-page" : "viewport",
      };
    }

    // ── DOM ──
    case "dom": {
      const page = getActivePage();
      if (!page) throw rpcError("no-active-page", "No active page.");

      const maxLength = params.maxLength ?? 50000;

      if (params.mode === "attributes" && params.selector) {
        const el = await page.$(params.selector);
        if (!el) throw rpcError("not-found", `Selector "${params.selector}" not found`);
        const attrs = await el.evaluate((e: Element) => {
          const attrs: Record<string, string> = {};
          for (const attr of e.attributes) {
            attrs[attr.name] = attr.value;
          }
          return attrs;
        });
        return { attributes: attrs, selector: params.selector };
      }

      if (params.mode === "computed" && params.selector && params.property) {
        const el = await page.$(params.selector);
        if (!el) throw rpcError("not-found", `Selector "${params.selector}" not found`);
        const value = await el.evaluate((e: Element, prop: string) =>
          getComputedStyle(e).getPropertyValue(prop), params.property);
        return { property: params.property, value, selector: params.selector };
      }

      if (params.mode === "text") {
        const text = params.selector
          ? await page.$eval(params.selector, (e: Element) => (e as HTMLElement).innerText || e.textContent || "")
          : await page.evaluate(() => document.body?.innerText || "");
        const truncated = text.length > maxLength;
        return {
          text: text.slice(0, maxLength),
          length: text.length,
          truncated,
          selector: params.selector ?? "body",
        };
      }

      // Default: HTML
      const html = params.selector
        ? await page.$eval(params.selector, (e: Element) => e.outerHTML)
        : await page.evaluate(() => document.documentElement?.outerHTML || "");
      const truncated = html.length > maxLength;
      return {
        html: html.slice(0, maxLength),
        length: html.length,
        truncated,
        selector: params.selector ?? "document",
      };
    }

    // ── JavaScript ──
    case "js": {
      const page = getActivePage();
      if (!page) throw rpcError("no-active-page", "No active page.");
      if (!params.script) throw rpcError("missing-script", "script is required");

      let result: any;
      try {
        result = await page.evaluate(params.script);
      } catch (err: any) {
        return { error: err.message, type: "error" };
      }

      const type = typeof result === "string" ? "string"
        : typeof result === "number" ? "number"
        : typeof result === "boolean" ? "boolean"
        : result === null ? "null"
        : Array.isArray(result) ? "array"
        : "object";

      return { result, type };
    }

    // ── Wait ──
    case "wait": {
      const page = getActivePage();
      if (!page) throw rpcError("no-active-page", "No active page.");

      const timeout = params?.timeout ?? 5000;

      switch (params.type) {
        case "timeout":
          await page.waitForTimeout(timeout);
          return { waited: timeout };
        case "selector":
          try {
            await page.waitForSelector(params.selector!, {
              state: params.state ?? "visible",
              timeout,
            });
          } catch (err: any) {
            await log("warn", "wait-selector-timeout", {
              selector: params.selector,
              timeout,
              error: err.message,
            });
            throw err;
          }
          return { found: true, selector: params.selector };
        case "navigation":
          try {
            await page.waitForNavigation({ timeout });
          } catch (err: any) {
            await log("warn", "wait-navigation-timeout", {
              timeout,
              error: err.message,
            });
            // Don't throw — page may have already loaded
            return { navigated: false, url: page.url(), timeout: true };
          }
          return { navigated: true, url: page.url() };
        case "network":
          try {
            await page.waitForLoadState("networkidle", { timeout });
          } catch {
            // networkidle often times out on SPAs — that's ok
            return { idle: false, timeout: true };
          }
          return { idle: true };
        case "function":
          try {
            await page.waitForFunction(params.script!, { timeout });
          } catch (err: any) {
            await log("warn", "wait-function-timeout", {
              timeout,
              error: err.message,
            });
            throw err;
          }
          return { condition: true };
        default:
          throw rpcError("invalid-wait-type", `Unknown wait type: ${params.type}`);
      }
    }

    // ── Tabs ──
    case "tabs": {
      const action = params.action ?? "list";

      switch (action) {
        case "list": {
          // Real titles. The previous implementation returned the literal
          // string "..." for every tab (`p.url() ? "..." : "(new tab)"`),
          // so the agent was shown placeholder data it could mistake for a
          // real page title.
          const entries = await Promise.all(
            Array.from(pages.entries()).map(async ([id, p]) => {
              let title = "";
              try {
                title = p.isClosed() ? "" : await p.title();
              } catch {}
              return {
                id,
                url: p.url(),
                title,
                active: id === activePageId,
                closed: p.isClosed(),
              };
            }),
          );
          return { pages: entries, activePageId };
        }

        case "switch":
          if (!params.tabId) throw rpcError("missing-tabId", "tabId required");
          if (!pages.has(params.tabId)) throw rpcError("not-found", `Tab "${params.tabId}" not found`);
          activePageId = params.tabId;
          return { switched: true, tabId: params.tabId };

        case "create": {
          if (pages.size >= MAX_TABS) throw rpcError("max-tabs", `Maximum ${MAX_TABS} tabs reached`);
          const newPage = context
            ? await context.newPage()
            : await browser!.newPage();
          const pageId = generatePageId();
          pages.set(pageId, newPage);
          activePageId = pageId;

          attachPageListeners(newPage, pageId);

          if (params.url) {
            await newPage.goto(params.url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
          }

          return { created: true, tabId: pageId, url: newPage.url() };
        }

        case "close": {
          if (!params.tabId) throw rpcError("missing-tabId", "tabId required");
          const p = pages.get(params.tabId);
          if (!p) throw rpcError("not-found", `Tab "${params.tabId}" not found`);
          await p.close();
          pages.delete(params.tabId);
          if (activePageId === params.tabId) {
            activePageId = getPageIds()[0] ?? null;
          }
          return { closed: true, tabId: params.tabId };
        }

        default:
          throw rpcError("invalid-action", `Unknown tab action: ${action}`);
      }
    }

    // ── Back / Forward ──
    case "back": {
      const page = getActivePage();
      if (!page) throw rpcError("no-active-page", "No active page.");
      const timeout = params?.timeout ?? NAVIGATION_TIMEOUT_MS;
      try {
        await page.goBack({ timeout });
      } catch (err: any) {
        await log("warn", "go-back-timeout", { timeout, error: err.message });
        // Page may be in a weird state — try to continue
      }
      return { url: page.url(), title: await page.title() };
    }

    case "forward": {
      const page = getActivePage();
      if (!page) throw rpcError("no-active-page", "No active page.");
      const timeout = params?.timeout ?? NAVIGATION_TIMEOUT_MS;
      try {
        await page.goForward({ timeout });
      } catch (err: any) {
        await log("warn", "go-forward-timeout", { timeout, error: err.message });
      }
      return { url: page.url(), title: await page.title() };
    }

    // ── Cookies ──
    case "cookies": {
      const page = getActivePage();
      if (!page) throw rpcError("no-active-page", "No active page.");

      const action = params.action ?? "get";
      switch (action) {
        case "get": {
          const cookies = await page.context().cookies();
          return { cookies };
        }
        case "set": {
          if (!params.cookies) throw rpcError("missing-cookies", "cookies array required");
          await page.context().addCookies(params.cookies);
          return { set: params.cookies.length };
        }
        case "clear":
          await page.context().clearCookies();
          return { cleared: true };
        default:
          throw rpcError("invalid-action", `Unknown cookie action: ${action}`);
      }
    }

    // ── Reload ──
    case "reload": {
      const page = getActivePage();
      if (!page) throw rpcError("no-active-page", "No active page.");
      const timeout = params?.timeout ?? NAVIGATION_TIMEOUT_MS;
      let response;
      try {
        response = await page.reload({ timeout });
      } catch (err: any) {
        await log("warn", "reload-timeout-recovering", { timeout, error: err.message });
        try {
          await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
        } catch {
          await recreateActivePage();
          const newPage = getActivePage();
          if (newPage) {
            response = await newPage.goto(page.url() || "about:blank", { waitUntil: "domcontentloaded", timeout });
          }
        }
      }
      // Report status like navigate does — a reload that came back 500 should
      // not look identical to a clean one.
      return {
        url: page.url(),
        title: await page.title(),
        status: response?.status() ?? null,
        ok: response ? response.ok() : null,
      };
    }

    case "diagnose": {
      const page = getActivePage();
      let pageInfo = null;
      if (page) {
        try {
          pageInfo = {
            url: page.url(),
            title: await page.title(),
            isClosed: page.isClosed(),
            isBlank: await isBlankPage(page).catch(() => null),
          };
        } catch (e: any) {
          pageInfo = { error: e.message };
        }
      }
      // Console health summary for the active page, so an agent calling
      // diagnose already sees "there were 3 console errors here" without
      // having to know to ask for them separately.
      let consoleSummary = null;
      if (activePageId) {
        const buf = consoleBuffers.get(activePageId) ?? [];
        const counts: Record<string, number> = {};
        for (const e of buf) counts[e.type] = (counts[e.type] ?? 0) + 1;
        consoleSummary = {
          total: buf.length,
          errors: (counts["error"] ?? 0) + (counts["pageerror"] ?? 0),
          warnings: counts["warning"] ?? 0,
          requestFailed: counts["requestfailed"] ?? 0,
          byType: counts,
        };
      }
      return {
        pid: process.pid,
        uptime: Date.now() - startupTime,
        browserAlive: browser !== null,
        contextAlive: context !== null,
        pagesCount: pages.size,
        activePageId,
        pageInfo,
        consoleSummary,
        screenshotDir: SCREENSHOT_DIR,
        screenshotDirExists: existsSync(SCREENSHOT_DIR),
        socketPath: SOCKET_PATH,
        socketExists: existsSync(SOCKET_PATH),
        logFile: LOG_FILE,
        memoryUsage: process.memoryUsage(),
        consecutiveBlankPages,
        lastHealthCheck,
      };
    }

    // ── Diagnostics: force a health check ──
    // The periodic check is throttled and runs off RPC traffic, so "did the
    // health check notice this?" is otherwise only answerable by waiting.
    // This also gives tests a deterministic hook.
    case "health_check": {
      await performHealthCheck();
      const p = getActivePage();
      return {
        ran: true,
        activePageId,
        url: p ? p.url() : null,
        isBlank: p ? await isBlankPage(p).catch(() => null) : null,
        isIntentionallyBlank: p ? isIntentionallyBlank(p) : null,
        consecutiveBlankPages,
        recreations: (await tailDaemonLog(1000, undefined, "page-recreated")).length,
      };
    }

    // ── Diagnostics: page console ──
    case "console_logs": {
      gcConsoleBuffers();
      const pageId = params?.pageId ?? activePageId;
      if (!pageId) throw rpcError("no-active-page", "No active page. Call init first.");
      const buf = consoleBuffers.get(pageId) ?? [];
      const level = params?.level as string | undefined;
      const since = typeof params?.since === "number" ? params.since : 0;
      const limit = Math.min(Math.max(params?.limit ?? 100, 1), CONSOLE_BUFFER_MAX);

      const filtered = buf.filter((e) => {
        if (e.t < since) return false;
        if (!level || level === "all") return true;
        if (level === "error") return e.type === "error" || e.type === "pageerror";
        if (level === "warning") return e.type === "warning";
        if (level === "network") return e.type === "requestfailed";
        return e.type === level;
      });

      const tail = filtered.slice(-limit);
      return {
        pageId,
        pageUrl: pages.get(pageId) ? pages.get(pageId)!.url() : null,
        total: buf.length,
        matched: filtered.length,
        returned: tail.length,
        truncated: filtered.length > tail.length,
        entries: tail,
      };
    }

    // ── Diagnostics: daemon activity log ──
    case "daemon_logs": {
      const limit = Math.min(Math.max(params?.limit ?? 50, 1), 1000);
      const level = params?.level as string | undefined;
      const grep = params?.grep as string | undefined;
      const tail = await tailDaemonLog(limit * 4, level, grep);
      return {
        logFile: LOG_FILE,
        exists: existsSync(LOG_FILE),
        returned: tail.length,
        entries: tail.slice(-limit),
      };
    }

    default:
      throw rpcError("unknown-method", `Unknown method: ${method}`);
  }
}

// ─── Element Resolution ────────────────────────────────────────────────────

async function resolveElement(page: Page, params: any) {
  if (params.selector) {
    const el = await page.$(params.selector);
    if (!el) {
      // Try to provide helpful context
      const tagNames = await page.evaluate(() =>
        Array.from(document.querySelectorAll("*")).slice(0, 50).map(e =>
          `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.className && typeof e.className === "string" ? "." + e.className.split(" ").filter(Boolean).join(".") : ""}`
        )
      );
      throw rpcError("not-found", `Element "${params.selector}" not found`, {
        availableElements: tagNames.slice(0, 20),
      });
    }
    return el;
  }

  if (params.text) {
    const el = await page.getByText(params.text, { exact: params.exact ?? false });
    try {
      return await el.elementHandle();
    } catch {
      throw rpcError("not-found", `Element with text "${params.text}" not found`);
    }
  }

  if (params.xpath) {
    const el = await page.$(`xpath=${params.xpath}`);
    if (!el) throw rpcError("not-found", `XPath "${params.xpath}" not found`);
    return el;
  }

  throw rpcError("missing-selector", "One of selector, text, or xpath is required");
}

// ─── URL Validation ────────────────────────────────────────────────────────

function validateUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw rpcError("invalid-url", `Invalid URL: ${url}`);
  }

  const blockedHosts = config.blockedHosts ?? [
    "localhost", "127.0.0.1", "0.0.0.0",
    "10.", "172.16.", "172.17.", "172.18.", "172.19.",
    "172.20.", "172.21.", "172.22.", "172.23.",
    "172.24.", "172.25.", "172.26.", "172.27.",
    "172.28.", "172.29.", "172.30.", "172.31.",
    "192.168.", "[::1]", "[::]", "file:",
  ];

  const host = parsed.hostname;
  const protocol = parsed.protocol;

  if (protocol === "file:") {
    throw rpcError("blocked-url", "file:// URLs are blocked for security");
  }

  for (const blocked of blockedHosts) {
    if (host === blocked || host.startsWith(blocked)) {
      throw rpcError("blocked-url", `URL "${url}" is blocked (matches ${blocked})`);
    }
  }
}

// ─── RPC Error ─────────────────────────────────────────────────────────────

function rpcError(code: string, message: string, data?: any) {
  const err: any = new Error(message);
  err.code = code;
  err.data = data;
  return err;
}

// ─── Socket Server ─────────────────────────────────────────────────────────

function startSocketServer() {
  server = createServer((socket: Socket) => {
    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let request: any;
        try {
          request = JSON.parse(line);
        } catch {
          socket.write(JSON.stringify({ error: { code: "parse-error", message: "Invalid JSON" } }) + "\n");
          continue;
        }

        const id = request.id;
        const method = request.method;
        const params = request.params;

        handleRPC(method, params)
          .then((result) => {
            socket.write(JSON.stringify({ id, result }) + "\n");
          })
          .catch((err: any) => {
            log("error", "rpc-error", { method, code: err.code, message: err.message });
            socket.write(JSON.stringify({
              id,
              error: { code: err.code ?? -32000, message: err.message, data: err.data },
            }) + "\n");
          });
      }
    });

    socket.on("error", (err) => {
      log("error", "socket-error", { error: err.message });
    });
  });

  server.listen(SOCKET_PATH, () => {
    logSync("info", "daemon-started", {
      pid: process.pid,
      socket: SOCKET_PATH,
      screenshotDir: SCREENSHOT_DIR,
    });
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  // Ensure directories exist
  await mkdir(RUN_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  await mkdir(PROFILES_DIR, { recursive: true });

  // Remove stale socket
  try { await unlink(SOCKET_PATH); } catch {}

  // Load config
  config = await loadConfig();

  // Handle signals
  let shuttingDown = false;
  process.on("SIGINT", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdown();
  });
  process.on("SIGTERM", () => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdown();
  });
  // SIGHUP is already ignored above
  process.on("uncaughtException", (err) => {
    logSync("fatal", "uncaught-exception", { error: err.message, stack: err.stack });
    // Don't exit — let the process try to recover
    // The health check will detect and recreate broken pages
  });

  // Prevent SIGHUP from killing us — parent processes may send this
  process.on("SIGHUP", () => {
    logSync("warn", "sighup-received-ignoring");
  });

  // Prevent SIGPIPE from killing us
  process.on("SIGPIPE", () => {
    logSync("warn", "sigpipe-received-ignoring");
  });
  process.on("unhandledRejection", (reason: any) => {
    logSync("error", "unhandled-rejection", { error: reason?.message || String(reason) });
  });

  // Start socket server
  startSocketServer();

  // Periodic health check interval (every 30s — more frequent to catch issues early)
  setInterval(() => {
    performHealthCheck().catch(() => {});
  }, 30000);

  // Auto-init browser if configured
  if (config.autoInit !== false) {
    try {
      await initBrowser(config.activeProfile);
    } catch (err: any) {
      await log("error", "auto-init-failed", { error: err.message });
    }
  }

  // Signal parent that daemon is ready (used by client)
  if (process.send) {
    process.send({ type: "ready", pid: process.pid });
  }
}

main().catch((err) => {
  logSync("fatal", "daemon-crash", { error: err.message, stack: err.stack });
  process.exit(1);
});
