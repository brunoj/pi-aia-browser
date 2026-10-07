/**
 * pi-aia-browser client — pi extension that provides browser automation tools.
 *
 * Communicates with a persistent daemon process via Unix socket.
 * Auto-starts the daemon if not running. All tools delegate to the daemon.
 *
 * Safe to load even if playwright isn't installed — the daemon installs
 * its own dependencies on first launch.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { connect as connectSocket, type Socket } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, access, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

// ─── Constants ─────────────────────────────────────────────────────────────

const isWin = process.platform === "win32";
const PI_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi");
const RUN_DIR = join(PI_DIR, "run");
// Must match daemon.ts SOCKET_PATH
const SOCKET_PATH = isWin
  ? join("\\\\?\\pipe", "pi-aia-browser")
  : join(RUN_DIR, "aia-browser.sock");
// Resolve paths safely — works with jiti (pi's TS loader) and native ESM
const _currentDir = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    // Fallback for environments where import.meta.url isn't available
    return process.env.PI_AIA_BROWSER_EXTENSION_DIR || join(PI_DIR, "agent", "extensions", "pi-aia-browser");
  }
})();
const DAEMON_SCRIPT = join(_currentDir, "src", "daemon.ts");
const EXTENSION_DIR = _currentDir;
const CONFIG_PATH = join(PI_DIR, "browser", "config.json");
const PROFILES_DIR = join(PI_DIR, "browser", "profiles");

const DAEMON_SPAWN_TIMEOUT = 15000; // 15s max wait for daemon to start
const RPC_TIMEOUT = 60000; // 60s for RPC calls (screenshots, slow pages)
const RPC_FAST_TIMEOUT = 5000; // 5s for health-check pings
const HEARTBEAT_INTERVAL = 10000; // 10s between connection health checks

// ─── State ─────────────────────────────────────────────────────────────────

let socket: Socket | null = null;
let daemonProcess: ChildProcess | null = null;
let rpcId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>();
let buffer = "";
let daemonReady = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let connecting = false; // prevent concurrent connection attempts

// ─── Config ────────────────────────────────────────────────────────────────

async function loadConfig(): Promise<any> {
  try {
    const data = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveConfig(config: any) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ─── Connection Health ────────────────────────────────────────────────────

function markDead(reason: string) {
  if (!daemonReady && !socket) return; // already dead
  daemonReady = false;
  if (socket) {
    try { socket.destroy(); } catch {}
    socket = null;
  }
  // Reject all pending with fast failure
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error(`Connection lost: ${reason}`));
  }
  pending.clear();
  stopHeartbeat();
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(async () => {
    if (!socket || !daemonReady) {
      stopHeartbeat();
      return;
    }
    try {
      await rpcCallRaw("ping", {}, RPC_FAST_TIMEOUT);
    } catch {
      // ping failed — connection is dead
      markDead("heartbeat failed");
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ─── Daemon Management ─────────────────────────────────────────────────────

async function ensureDaemon(ctx?: ExtensionCommandContext): Promise<boolean> {
  // If we think we're connected but socket is dead, clean up first
  if (socket && (socket.destroyed || !socket.writable)) {
    markDead("stale socket before ensure");
  }
  if (daemonReady && socket) return true;
  if (connecting) {
    // Another call is already trying to connect; wait for it
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      if (daemonReady && socket) return true;
    }
    return false;
  }

  connecting = true;
  try {
    // Try connecting to existing daemon
    if (await tryConnect()) {
      daemonReady = true;
      startHeartbeat();
      return true;
    }

    // Spawn new daemon
    await spawnDaemon(ctx);

    // Wait for connection
    const deadline = Date.now() + DAEMON_SPAWN_TIMEOUT;
    while (Date.now() < deadline) {
      await sleep(200);
      if (await tryConnect()) {
        daemonReady = true;
        startHeartbeat();
        return true;
      }
    }

    return false;
  } finally {
    connecting = false;
  }
}

async function tryConnect(): Promise<boolean> {
  // On Windows with named pipes, access() won't work — just try connecting
  if (!isWin) {
    try {
      await access(SOCKET_PATH);
    } catch {
      return false;
    }
  }

  return new Promise((resolve) => {
    const s = connectSocket(SOCKET_PATH, () => {
      // Connection succeeded — clear the connect timeout
      s.setTimeout(0);
      // Set up handlers BEFORE assigning to module-level socket
      // to avoid race where an error fires between assignment and handler setup
      setupSocketHandlers(s);
      buffer = "";
      socket = s;
      resolve(true);
    });
    s.once("error", () => {
      s.destroy();
      resolve(false);
    });
    // Connection timeout: if connect takes >5s, give up
    s.setTimeout(5000);
    s.once("timeout", () => {
      // Only treat as failure if we haven't connected yet
      if (!socket) {
        s.destroy();
        resolve(false);
      }
      // If already connected, this is an idle timeout — ignore it
      // (the heartbeat keeps the connection alive)
    });
  });
}

function setupSocketHandlers(s: Socket) {
  // Ensure flowing mode — some Node.js versions need explicit resume
  s.resume();
  s.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const response = JSON.parse(line);
        const pending_handler = pending.get(response.id);
        if (pending_handler) {
          clearTimeout(pending_handler.timer);
          pending.delete(response.id);
          if (response.error) {
            const err = new Error(response.error.message);
            (err as any).code = response.error.code;
            (err as any).data = response.error.data;
            pending_handler.reject(err);
          } else {
            pending_handler.resolve(response.result);
          }
        }
      } catch {}
    }
  });

  s.on("error", (err) => {
    markDead(err.message);
  });

  s.on("close", () => {
    if (daemonReady || socket) {
      markDead("socket closed");
    }
  });
}

async function spawnDaemon(ctx?: ExtensionCommandContext) {
  // Ensure node_modules are installed
  const pkgPath = join(EXTENSION_DIR, "package.json");
  const nmPath = join(EXTENSION_DIR, "node_modules");
  if (!existsSync(nmPath)) {
    if (ctx) {
      ctx.ui.notify("Installing pi-aia-browser dependencies...", "info");
    }
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("npm", ["install"], {
        cwd: EXTENSION_DIR,
        stdio: "pipe",
        shell: true,
      });
      let out = "";
      proc.stdout?.on("data", (d) => { out += d; });
      proc.stderr?.on("data", (d) => { out += d; });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`npm install failed: ${out.slice(-200)}`));
      });
      proc.on("error", reject);
    });
  }

  await mkdir(RUN_DIR, { recursive: true });

  // Find tsx — check local node_modules, npx cache, or global
  const isWin = process.platform === "win32";
  const tsxPaths = [
    join(EXTENSION_DIR, "node_modules", ".bin", isWin ? "tsx.cmd" : "tsx"),
  ];
  // Add npx cache paths
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    tsxPaths.push(
      join(localAppData, "npm-cache", "_npx", "fd45a72a545557e9", "node_modules", ".bin", "tsx.cmd"),
    );
  } else {
    tsxPaths.push(
      join(homedir(), ".npm", "_npx", "fd45a72a545557e9", "node_modules", ".bin", "tsx"),
    );
  }
  // Search for tsx via where/which
  try {
    const { execSync } = await import("node:child_process");
    const cmd = isWin
      ? `where tsx.cmd 2>nul`
      : "which tsx 2>/dev/null || npx --yes tsx --version 2>/dev/null && which tsx";
    const which = execSync(cmd, {
      stdio: "pipe",
      timeout: 5000,
    }).toString().trim().split(/\r?\n/)[0];
    if (which) tsxPaths.unshift(which);
  } catch {}

  let tsxPath = tsxPaths.find(p => existsSync(p));
  if (!tsxPath) {
    // Fallback: use npx via shell (required on Windows for .cmd resolution)
    const proc = spawn(
      isWin ? "npx.cmd" : "npx",
      ["--yes", "tsx", DAEMON_SCRIPT],
      {
        cwd: EXTENSION_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        shell: isWin, // Windows needs shell for .cmd files
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: PI_DIR,
          PI_AIA_BROWSER_EXTENSION_DIR: EXTENSION_DIR,
        },
      }
    );
    proc.unref();
    daemonProcess = proc;
    proc.stdout?.on("data", () => {});
    proc.stderr?.on("data", () => {});
    proc.on("exit", (code) => {
      daemonProcess = null;
      daemonReady = false;
    });
    return;
  }

  // Resolve tsx loader — tsxPath may be a symlink (Unix) or .cmd wrapper (Windows)
  // On Unix, .bin/tsx -> ../tsx/dist/loader.mjs
  // On Windows, .bin/tsx.cmd is a batch file; find the real tsx package dir
  let tsxLoader = join(dirname(tsxPath), "..", "tsx", "dist", "loader.mjs");
  if (!existsSync(tsxLoader)) {
    // Fallback: try without the tsx subdirectory (some setups)
    tsxLoader = join(dirname(tsxPath), "..", "dist", "loader.mjs");
  }
  const loaderUrl = `file://${tsxLoader}`;

  const proc = spawn(
    process.execPath,
    ["--import", loaderUrl, DAEMON_SCRIPT],
    {
      cwd: EXTENSION_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: PI_DIR,
        PI_AIA_BROWSER_EXTENSION_DIR: EXTENSION_DIR,
      },
    }
  );
  proc.unref();
  daemonProcess = proc;

  proc.stdout?.on("data", () => {}); // Drain
  proc.stderr?.on("data", () => {}); // Drain

  proc.on("exit", (code) => {
    daemonProcess = null;
    daemonReady = false;
  });
}

// ─── RPC Call ──────────────────────────────────────────────────────────────

async function rpcCallRaw(method: string, params: any, timeout: number): Promise<any> {
  if (!socket) throw new Error("No socket connection");
  // Check if socket is actually writable — prevents silent failure on half-open connections
  if (!socket.writable || socket.destroyed) {
    markDead("socket not writable");
    throw new Error("Socket not writable — reconnecting");
  }

  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    const timer = setTimeout(() => {
      pending.delete(id);
      markDead(`RPC timeout: ${method}`);
      reject(new Error(`RPC timeout: ${method}`));
    }, timeout);

    pending.set(id, { resolve, reject, timer });

    try {
      const data = JSON.stringify({ id, method, params }) + "\n";
      const written = socket!.write(data, (err) => {
        if (err) {
          clearTimeout(timer);
          pending.delete(id);
          markDead(`write error: ${err.message}`);
          reject(err);
        }
      });
      if (!written) {
        // Socket buffer full — connection is likely dead
        clearTimeout(timer);
        pending.delete(id);
        markDead("socket buffer full");
        reject(new Error("Socket buffer full — connection lost"));
      }
    } catch (err: any) {
      clearTimeout(timer);
      pending.delete(id);
      markDead(err.message);
      reject(err);
    }
  });
}

async function rpcCall(method: string, params?: any): Promise<any> {
  // Check if existing socket is actually alive before using it
  if (socket && daemonReady) {
    if (!socket.writable || socket.destroyed) {
      markDead("socket dead before rpc");
    }
  }
  if (!socket || !daemonReady) {
    const ok = await ensureDaemon();
    if (!ok) throw new Error("Failed to connect to browser daemon");
  }

  return rpcCallRaw(method, params ?? {}, RPC_TIMEOUT);
}

// ─── Profile Management ────────────────────────────────────────────────────

async function listProfiles(): Promise<string[]> {
  try {
    // readdir, not readFile — readFile on a directory throws EISDIR, which the
    // .catch below swallowed, so this silently always returned [].
    const entries = await readdir(PROFILES_DIR, { withFileTypes: true }).catch(() => []);
    const items = Array.isArray(entries) ? entries : [];
    return items
      .filter((e: any) => e.isDirectory?.())
      .map((e: any) => e.name);
  } catch {
    return [];
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── browser_init ──
  pi.registerTool({
    name: "browser_init",
    label: "Browser Init",
    description:
      "Start or ensure the browser daemon is running. Optionally specify a profile. " +
      "The daemon persists across pi sessions — call this once at the start of a browsing session.",
    promptSnippet: "Initialize the browser for web automation",
    promptGuidelines: [
      "Use browser_init at the start of a browsing session to ensure the browser daemon is running.",
      "After browser_init, you can navigate, click, type, screenshot, and more.",
      "The browser daemon persists across turns — you don't need to init again unless it was stopped.",
    ],
    parameters: Type.Object({
      profile: Type.Optional(
        Type.String({ description: "Browser profile name (optional). Use 'default' for ephemeral." }),
      ),
    }),
    async execute() {
      const ok = await ensureDaemon();
      if (!ok) {
        return {
          content: [{ type: "text" as const, text: "Failed to start browser daemon. Check ~/.pi/agent/logs/pi-aia-browser/daemon.log" }],
          details: {},
          isError: true,
        };
      }
      const status = await rpcCall("ping");
      return {
        content: [{ type: "text" as const, text: `Browser daemon is running.\nPID: ${status.pong ? "active" : "unknown"}\nUptime: ${Math.round(status.uptime / 1000)}s\nPages: ${status.pages}\nActive tab: ${status.activePage ?? "none"}` }],
        details: status,
      };
    },
  });

  // ── browser_navigate ──
  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Navigate the active browser tab to a URL. Returns the page title, final URL, and HTTP status.",
    promptSnippet: "Navigate to a URL in the browser",
    parameters: Type.Object({
      url: Type.String({ description: "The URL to navigate to (must start with http:// or https://)" }),
      waitUntil: Type.Optional(
        StringEnum(["load", "domcontentloaded", "networkidle", "commit"] as const),
      ),
      timeout: Type.Optional(Type.Number({ description: "Navigation timeout in ms (default: 30000)" })),
    }),
    async execute(_id: string, params: any) {
      const result = await rpcCall("navigate", params);
      return {
        content: [{ type: "text" as const, text: `Navigated to ${result.url}\nTitle: ${result.title}\nStatus: ${result.status}` }],
        details: result,
      };
    },
  });

  // ── browser_click ──
  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description: "Click an element on the page. Supports CSS selector, text content, or XPath.",
    promptSnippet: "Click an element in the browser",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "CSS selector for the element" })),
      text: Type.Optional(Type.String({ description: "Click element containing this text" })),
      xpath: Type.Optional(Type.String({ description: "XPath selector" })),
      waitForNavigation: Type.Optional(
        Type.Boolean({ description: "Wait for page to load after click (default: false)" }),
      ),
      button: Type.Optional(StringEnum(["left", "right", "middle"] as const)),
      clickCount: Type.Optional(Type.Integer({ description: "1=single, 2=double (default: 1)" })),
    }),
    async execute(_id: string, params: any) {
      const result = await rpcCall("click", params);
      return {
        content: [{ type: "text" as const, text: `Clicked. URL: ${result.url}\nTitle: ${result.title}` }],
        details: result,
      };
    },
  });

  // ── browser_type ──
  pi.registerTool({
    name: "browser_type",
    label: "Browser Type",
    description: "Type text into an input field. Optionally clear first and/or press Enter after.",
    promptSnippet: "Type text into a browser input field",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "CSS selector for the input" })),
      text: Type.Optional(Type.String({ description: "Click element containing this text to focus first" })),
      value: Type.String({ description: "Text to type into the field" }),
      clear: Type.Optional(Type.Boolean({ description: "Clear existing value first (default: false)" })),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing (default: false)" })),
    }),
    async execute(_id: string, params: any) {
      const result = await rpcCall("type", params);
      return {
        content: [{ type: "text" as const, text: `Typed "${params.value}" into field.` }],
        details: result,
      };
    },
  });

  // ── browser_screenshot ──
  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Take a screenshot of the current page. Saves as PNG. " +
      "The pi-vision-handoff extension will automatically describe the image for text-only models. " +
      "Use this to inspect UIs, verify layouts, or debug visual issues.",
    promptSnippet: "Take a screenshot of the current browser page",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "CSS selector to capture a specific element" })),
      fullPage: Type.Optional(
        Type.Boolean({ description: "Capture full scrollable page (default: false)" }),
      ),
    }),
    async execute(_id: string, params: any) {
      const result = await rpcCall("screenshot", params);
      return {
        content: [
          { type: "text" as const, text: `Screenshot saved to ${result.filepath}\nURL: ${result.url}\nTitle: ${result.title}\nMode: ${result.viewport}` },
        ],
        details: result,
      };
    },
  });

  // ── browser_dom ──
  pi.registerTool({
    name: "browser_dom",
    label: "Browser DOM",
    description: "Get the DOM of the current page. Can return HTML, text content, attributes, or computed styles.",
    promptSnippet: "Inspect the DOM of the current browser page",
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "CSS selector to target a specific element" })),
      mode: Type.Optional(
        StringEnum(["html", "text", "attributes", "computed"] as const),
      ),
      property: Type.Optional(Type.String({ description: "CSS property name (for computed mode)" })),
      maxLength: Type.Optional(Type.Integer({ description: "Truncation limit in chars (default: 50000)" })),
    }),
    async execute(_id: string, params: any) {
      const result = await rpcCall("dom", params);
      const mode = params.mode ?? "html";
      let text = "";
      if (mode === "text") {
        text = result.text ?? "";
      } else if (mode === "attributes") {
        text = JSON.stringify(result.attributes, null, 2);
      } else if (mode === "computed") {
        text = `${result.property}: ${result.value}`;
      } else {
        text = result.html ?? "";
      }
      if (result.truncated) {
        text += `\n\n[... truncated: showing ${text.length} of ${result.length} chars]`;
      }
      return {
        content: [{ type: "text" as const, text }],
        details: result,
      };
    },
  });

  // ── browser_js ──
  pi.registerTool({
    name: "browser_js",
    label: "Browser JS",
    description: "Execute JavaScript in the browser page context. Returns the result.",
    promptSnippet: "Execute JavaScript in the browser",
    parameters: Type.Object({
      script: Type.String({ description: "JavaScript code to execute in the page context" }),
    }),
    async execute(_id: string, params: any) {
      const result = await rpcCall("js", params);
      if (result.error) {
        return {
          content: [{ type: "text" as const, text: `JS Error: ${result.error}` }],
          details: result,
          isError: true,
        };
      }
      const text = typeof result.result === "object"
        ? JSON.stringify(result.result, null, 2)
        : String(result.result);
      return {
        content: [{ type: "text" as const, text }],
        details: result,
      };
    },
  });

  // ── browser_scroll ──
  pi.registerTool({
    name: "browser_scroll",
    label: "Browser Scroll",
    description: "Scroll the page. Supports up/down by pixels, to a position, to an element, or to top/bottom.",
    promptSnippet: "Scroll the browser page",
    parameters: Type.Object({
      direction: Type.Optional(
        StringEnum(["up", "down", "to", "toElement", "top", "bottom"] as const),
      ),
      amount: Type.Optional(Type.Integer({ description: "Pixels to scroll (for up/down, default: 300)" })),
      selector: Type.Optional(Type.String({ description: "CSS selector to scroll to (for toElement)" })),
      x: Type.Optional(Type.Integer({ description: "X position to scroll to (for 'to' direction)" })),
      y: Type.Optional(Type.Integer({ description: "Y position to scroll to (for 'to' direction)" })),
    }),
    async execute(_id: string, params: any) {
      const result = await rpcCall("scroll", params);
      return {
        content: [{ type: "text" as const, text: `Scrolled ${result.direction}. Position: (${result.position.x}, ${result.position.y})` }],
        details: result,
      };
    },
  });

  // ── browser_wait ──
  pi.registerTool({
    name: "browser_wait",
    label: "Browser Wait",
    description: "Wait for a condition: timeout, element selector, navigation, network idle, or a custom JS function.",
    promptSnippet: "Wait for a condition in the browser",
    parameters: Type.Object({
      type: StringEnum(["timeout", "selector", "navigation", "network", "function"] as const),
      selector: Type.Optional(Type.String({ description: "CSS selector to wait for (for 'selector' type)" })),
      state: Type.Optional(
        StringEnum(["attached", "detached", "visible", "hidden"] as const),
      ),
      timeout: Type.Optional(Type.Integer({ description: "Timeout in ms (default: 5000)" })),
      script: Type.Optional(Type.String({ description: "JS function body that returns truthy (for 'function' type)" })),
    }),
    async execute(_id: string, params: any) {
      const result = await rpcCall("wait", params);
      return {
        content: [{ type: "text" as const, text: `Wait condition met: ${params.type}` }],
        details: result,
      };
    },
  });

  // ── browser_tabs ──
  pi.registerTool({
    name: "browser_tabs",
    label: "Browser Tabs",
    description: "Manage browser tabs: list, switch, create, or close.",
    promptSnippet: "Manage browser tabs",
    parameters: Type.Object({
      action: StringEnum(["list", "switch", "create", "close"] as const),
      tabId: Type.Optional(Type.String({ description: "Tab ID (for switch/close)" })),
      url: Type.Optional(Type.String({ description: "URL to open (for create)" })),
    }),
    async execute(_id: string, params: any) {
      const result = await rpcCall("tabs", params);
      if (params.action === "list") {
        const lines = result.pages.map((p: any) =>
          `  ${p.active ? "→" : " "} ${p.id}: ${p.title || "(new tab)"} — ${p.url || "(blank)"}`
        ).join("\n");
        return {
          content: [{ type: "text" as const, text: `Tabs (${result.pages.length}):\n${lines}` }],
          details: result,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  // ── browser_back ──
  pi.registerTool({
    name: "browser_back",
    label: "Browser Back",
    description: "Go back one page in the browser history.",
    promptSnippet: "Go back in browser history",
    parameters: Type.Object({}),
    async execute() {
      const result = await rpcCall("back");
      return {
        content: [{ type: "text" as const, text: `Back to: ${result.url}\nTitle: ${result.title}` }],
        details: result,
      };
    },
  });

  // ── browser_forward ──
  pi.registerTool({
    name: "browser_forward",
    label: "Browser Forward",
    description: "Go forward one page in the browser history.",
    promptSnippet: "Go forward in browser history",
    parameters: Type.Object({}),
    async execute() {
      const result = await rpcCall("forward");
      return {
        content: [{ type: "text" as const, text: `Forward to: ${result.url}\nTitle: ${result.title}` }],
        details: result,
      };
    },
  });

  // ── browser_reload ──
  pi.registerTool({
    name: "browser_reload",
    label: "Browser Reload",
    description: "Reload the current page.",
    promptSnippet: "Reload the current browser page",
    parameters: Type.Object({}),
    async execute() {
      const result = await rpcCall("reload");
      return {
        content: [{ type: "text" as const, text: `Reloaded: ${result.url}\nTitle: ${result.title}` }],
        details: result,
      };
    },
  });

  // ── browser_cookies ──
  pi.registerTool({
    name: "browser_cookies",
    label: "Browser Cookies",
    description: "Get, set, or clear browser cookies.",
    promptSnippet: "Manage browser cookies",
    parameters: Type.Object({
      action: StringEnum(["get", "set", "clear"] as const),
      cookies: Type.Optional(Type.Array(Type.Any(), { description: "Cookies to set (for 'set' action)" })),
    }),
    async execute(_id: string, params: any) {
      const result = await rpcCall("cookies", params);
      if (params.action === "get") {
        const lines = result.cookies.map((c: any) =>
          `  ${c.name}=${c.value} (${c.domain}${c.path})`
        ).join("\n");
        return {
          content: [{ type: "text" as const, text: `Cookies (${result.cookies.length}):\n${lines || "  (none)"}` }],
          details: result,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: result,
      };
    },
  });

  // ── browser_diagnose ──
  pi.registerTool({
    name: "browser_diagnose",
    label: "Browser Diagnose",
    description:
      "Diagnose the browser daemon status. Returns detailed health info including memory, page state, configuration, " +
      "a consoleSummary (how many console errors/warnings/failed requests each check has seen) and the daemon log file path. " +
      "For the entries behind those counts use browser_console; for daemon-side events use browser_logs.",
    parameters: Type.Object({}),
    async execute() {
      const result = await rpcCall("diagnose");
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  // ── browser_console ──
  pi.registerTool({
    name: "browser_console",
    label: "Browser Console",
    description:
      "Read the page's console output: console.log/info/warn/error/debug, uncaught page errors, and failed network requests. " +
      "Captured continuously by the daemon for every tab — no setup needed. " +
      "Use this during browser testing to check for JS errors instead of guessing from a screenshot. " +
      "Defaults to the active tab; pass pageId to read another tab (including a recently closed one).",
    promptSnippet: "Read the browser page's console output and JS errors",
    parameters: Type.Object({
      level: Type.Optional(
        StringEnum(["all", "error", "warning", "info", "log", "debug", "network"] as const),
      ),
      limit: Type.Optional(Type.Integer({ description: "Max entries to return (default 100, max 500)" })),
      since: Type.Optional(Type.Integer({ description: "Only entries at/after this epoch-ms timestamp" })),
      pageId: Type.Optional(Type.String({ description: "Tab id (default: active tab)" })),
    }),
    async execute(_id: string, params: any) {
      const result = await rpcCall("console_logs", params ?? {});
      const entries: any[] = result.entries ?? [];
      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No console entries${params?.level && params.level !== "all" ? ` for level=${params.level}` : ""} on tab ${result.pageId}${result.pageUrl ? ` (${result.pageUrl})` : ""}.`,
            },
          ],
          details: result,
        };
      }
      const lines = entries.map((e) => {
        const ts = new Date(e.t).toISOString();
        return `[${ts}] ${e.type}: ${e.text}`;
      });
      const header =
        `Console for tab ${result.pageId}${result.pageUrl ? ` (${result.pageUrl})` : ""} — ` +
        `${result.returned} of ${result.matched} matching (${result.total} captured total)` +
        `${result.truncated ? ", older entries omitted" : ""}:`;
      return {
        content: [{ type: "text" as const, text: `${header}\n${lines.join("\n")}` }],
        details: result,
      };
    },
  });

  // ── browser_logs ──
  pi.registerTool({
    name: "browser_logs",
    label: "Browser Logs",
    description:
      "Read the browser daemon's own activity log: navigations, timeouts, RPC errors, page recreations, health-check recoveries. " +
      "Use this when a browser action misbehaves or hangs and you need to know what the daemon actually did. " +
      "Filter by level (info/warn/error) or grep for a substring.",
    promptSnippet: "Read the browser daemon's activity log",
    parameters: Type.Object({
      level: Type.Optional(
        StringEnum(["all", "info", "warn", "error", "fatal"] as const),
      ),
      limit: Type.Optional(Type.Integer({ description: "Max entries to return (default 50, max 1000)" })),
      grep: Type.Optional(Type.String({ description: "Case-insensitive substring filter on the log line" })),
    }),
    async execute(_id: string, params: any) {
      const result = await rpcCall("daemon_logs", params ?? {});
      const entries: any[] = result.entries ?? [];
      if (!result.exists) {
        return {
          content: [{ type: "text" as const, text: `Daemon log not found at ${result.logFile}` }],
          details: result,
        };
      }
      if (entries.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No daemon log entries${params?.level && params.level !== "all" ? ` for level=${params.level}` : ""}${params?.grep ? ` matching "${params.grep}"` : ""}.`,
            },
          ],
          details: result,
        };
      }
      const lines = entries.map((e) => {
        const data = e.data ? ` ${JSON.stringify(e.data)}` : "";
        return `[${e.t}] ${e.level.toUpperCase()}: ${e.msg}${data}`;
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Daemon log (${result.logFile}) — last ${result.returned} matching entries:\n${lines.join("\n")}`,
          },
        ],
        details: result,
      };
    },
  });

  // ── browser_close ──
  pi.registerTool({
    name: "browser_close",
    label: "Browser Close",
    description: "Shut down the browser daemon. All tabs and sessions will be lost.",
    promptSnippet: "Shut down the browser daemon",
    parameters: Type.Object({}),
    async execute() {
      stopHeartbeat();
      try {
        await rpcCall("shutdown");
      } catch {}
      markDead("shutdown");
      return {
        content: [{ type: "text" as const, text: "Browser daemon shut down." }],
        details: {},
      };
    },
  });

  // ── Commands ──
  pi.registerCommand("browser", {
    description: "Manage the browser daemon. Usage: /browser start|stop|status|restart|profile",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = (args || "").trim().split(/\s+/);
      const cmd = parts[0] || "status";

      switch (cmd) {
        case "start": {
          const profile = parts[1];
          const ok = await ensureDaemon(ctx);
          if (!ok) {
            ctx.ui.notify("Failed to start browser daemon", "error");
            return;
          }
          if (profile) {
            await rpcCall("init", { profile });
          }
          ctx.ui.notify("Browser daemon started", "info");
          break;
        }

        case "stop": {
          try {
            await rpcCall("shutdown");
          } catch {}
          daemonReady = false;
          socket = null;
          ctx.ui.notify("Browser daemon stopped", "info");
          break;
        }

        case "status": {
          try {
            const status = await rpcCall("ping");
            const config = await loadConfig();
            const lines = [
              `Browser daemon: running`,
              `Uptime: ${Math.round(status.uptime / 1000)}s`,
              `Pages: ${status.pages}`,
              `Active profile: ${config.activeProfile ?? "ephemeral"}`,
              `Active tab: ${status.activePage ?? "none"}`,
            ];
            ctx.ui.notify(lines.join(" | "), "info");
          } catch {
            ctx.ui.notify("Browser daemon: not running", "warning");
          }
          break;
        }

        case "diagnose": {
          try {
            const diag = await rpcCall("diagnose");
            ctx.ui.notify(JSON.stringify(diag, null, 2), "info");
          } catch (e: any) {
            ctx.ui.notify(`Diagnose failed: ${e.message}`, "error");
          }
          break;
        }

        case "health": {
          try {
            const diag = await rpcCall("diagnose");
            const page = diag.pageInfo;
            const mem = diag.memoryUsage;
            const lines = [
              `PID: ${diag.pid}`,
              `Uptime: ${Math.round(diag.uptime / 1000)}s`,
              `Browser: ${diag.browserAlive ? "alive" : "dead"}`,
              `Pages: ${diag.pagesCount}`,
              `Active: ${diag.activePageId}`,
              `Blank pages detected: ${diag.consecutiveBlankPages}`,
              `Page URL: ${page?.url ?? "none"}`,
              `Page blank: ${page?.isBlank ?? "unknown"}`,
              `Memory: ${Math.round(mem?.rss / 1024 / 1024)}MB RSS, ${Math.round(mem?.heapUsed / 1024 / 1024)}MB heap`,
            ];
            ctx.ui.notify(lines.join(" | "), "info");
          } catch (e: any) {
            ctx.ui.notify(`Health check failed: ${e.message}`, "error");
          }
          break;
        }

        case "restart": {
          try { await rpcCall("shutdown"); } catch {}
          daemonReady = false;
          socket = null;
          await sleep(500);
          const ok = await ensureDaemon(ctx);
          ctx.ui.notify(ok ? "Browser daemon restarted" : "Failed to restart", ok ? "info" : "error");
          break;
        }

        case "profile": {
          const sub = parts[1];
          if (sub === "list") {
            const profiles = await listProfiles();
            const config = await loadConfig();
            const active = config.activeProfile;
            const lines = profiles.length
              ? profiles.map((p: string) => `  ${p === active ? "→" : " "} ${p}`).join("\n")
              : "  (no profiles)";
            ctx.ui.notify(`Profiles:\n${lines}`, "info");
          } else if (sub === "switch") {
            const name = parts[2];
            if (!name) {
              ctx.ui.notify("Usage: /browser profile switch <name>", "warning");
              return;
            }
            const config = await loadConfig();
            config.activeProfile = name;
            await saveConfig(config);
            ctx.ui.notify(`Profile switched to "${name}". Restart daemon to apply: /browser restart`, "info");
          } else if (sub === "import") {
            const name = parts[2];
            const source = parts[3];
            if (!name || !source) {
              ctx.ui.notify("Usage: /browser profile import <name> <source-path>", "warning");
              return;
            }
            const dest = join(PROFILES_DIR, name);
            await mkdir(dest, { recursive: true });
            // Copy profile
            const { execSync } = await import("node:child_process");
            try {
              execSync(`cp -r "${source}/"* "${dest}/"`, { stdio: "pipe" });
            } catch (err: any) {
              ctx.ui.notify(`Import failed: ${err.message}`, "error");
              return;
            }
            const config = await loadConfig();
            config.activeProfile = name;
            config.profiles = config.profiles || {};
            config.profiles[name] = { path: dest, source, lastSync: new Date().toISOString(), type: "copy" };
            await saveConfig(config);
            ctx.ui.notify(`Profile "${name}" imported from ${source}. Restart daemon: /browser restart`, "info");
          } else {
            ctx.ui.notify("Usage: /browser profile list|switch <name>|import <name> <source>", "info");
          }
          break;
        }

        default:
          ctx.ui.notify("Usage: /browser start|stop|status|diagnose|health|restart|profile [list|switch|import]", "info");
      }
    },
  });

  // ── Session lifecycle ──
  pi.on("session_start", async () => {
    // Don't auto-start — let the first tool call trigger it.
    // But try to connect if daemon is already running.
    try {
      if (await tryConnect()) {
        daemonReady = true;
      }
    } catch {}
  });

  pi.on("session_shutdown", async () => {
    // Don't kill the daemon — it persists across sessions.
    // Just clean up the client side.
    stopHeartbeat();
    markDead("session shutdown");
  });
}
