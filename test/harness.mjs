/**
 * Test harness for pi-aia-browser.
 *
 * Drives the REAL daemon over its real Unix-socket JSON-RPC protocol — the
 * same path the pi extension uses. No mocks of the thing under test: a mocked
 * Playwright would hide exactly the class of bug this suite exists to catch
 * (listeners silently missing on some page-creation path).
 *
 * Isolation: PI_CODING_AGENT_DIR is pointed at a temp dir, so the daemon uses
 * its own socket/log/profile paths and never touches the developer's live
 * browser session.
 */

import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..");
export const DAEMON_SCRIPT = join(REPO_ROOT, "src", "daemon.ts");

/**
 * Resolve a tsx loader the same way the extension does (index.ts spawnDaemon):
 * local node_modules, global npm root, `which tsx`, then the npx cache.
 * Hardcoding one path breaks the moment the npx cache is cleared.
 */
export function resolveTsxLoader() {
  const candidates = [];
  candidates.push(join(REPO_ROOT, "node_modules", ".bin", "tsx"));
  candidates.push(join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs"));
  try {
    const g = execSync("npm root -g", { encoding: "utf8", timeout: 10000 }).trim();
    candidates.push(join(g, "tsx", "dist", "loader.mjs"));
    candidates.push(join(g, "@earendil-works", "pi-coding-agent", "node_modules", "tsx", "dist", "loader.mjs"));
  } catch {}
  try {
    const which = execSync("which tsx", { encoding: "utf8", timeout: 5000 })
      .toString()
      .trim()
      .split(/\r?\n/)[0];
    if (which) candidates.push(dirname(which), join(dirname(which), "..", "tsx", "dist", "loader.mjs"));
  } catch {}
  // npx cache as a last resort (this is what pi itself often uses)
  try {
    const npxBase = join(process.env.HOME || "/home/brunoj", ".npm", "_npx");
    for (const hash of readdirSync(npxBase)) {
      const p = join(npxBase, hash, "node_modules", "tsx", "dist", "loader.mjs");
      if (existsSync(p)) candidates.push(p);
    }
  } catch {}

  for (const c of candidates) {
    if (!existsSync(c)) continue;
    // .bin/tsx is a symlink/wrapper — derive the loader from its target dir
    if (c.endsWith(".bin/tsx") || c.endsWith(".bin\\tsx")) {
      const derived = join(dirname(c), "..", "tsx", "dist", "loader.mjs");
      if (existsSync(derived)) return derived;
      const derived2 = join(dirname(c), "..", "dist", "loader.mjs");
      if (existsSync(derived2)) return derived2;
      continue;
    }
    return c;
  }
  throw new Error(`Could not resolve a tsx loader. Tried:\n  ${candidates.join("\n  ")}`);
}

// ─── Tiny assertion / reporting helpers ────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

export function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

export function section(title) {
  console.log(`\n${title}`);
}

export function summary(file) {
  console.log(`\n${passed} passed, ${failed} failed (${file})`);
  if (failed > 0) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  return failed === 0;
}

// ─── Fixture HTTP server ───────────────────────────────────────────────────

const PAGE = `<!doctype html><html><head><title>Browser Fixture</title></head><body>
<h1 id="hdr">Fixture</h1>
<input id="inp" type="text" placeholder="Search">
<button id="btn">Go</button>
<div id="out"></div>
<div id="async">pending</div>
<a id="lnk" href="/p2">second page</a>
<script>
  window.__js = 40 + 2;
  document.getElementById('btn').addEventListener('click', function () {
    document.getElementById('out').textContent = 'clicked:' + document.getElementById('inp').value;
  });
  console.log("fixture-log");
  console.warn("fixture-warn");
  console.error("fixture-console-error");
  setTimeout(function () {
    document.getElementById('async').textContent = 'enriched';
  }, 300);
</script>
</body></html>`;

const PAGE2 = `<!doctype html><html><head><title>Page Two</title></head><body><h1>PAGE2-OK</h1></body></html>`;
const BOOM = `<!doctype html><html><body><h1>boom</h1><script>undefinedFn();</script></body></html>`;
const THROWS_LATER = `<!doctype html><html><body><h1>later</h1><script>setTimeout(function(){ throw new Error("DELAYED-UNCAUGHT-777"); }, 100);</script></body></html>`;
const SLOW = `<!doctype html><html><body>SLOW-OK</body></html>`;

/**
 * Start the fixture server on an ephemeral port. Returns { origin, close }.
 * Uses 127.0.0.1 — the daemon's default blocklist is disabled by test config.
 */
export async function startFixtureServer() {
  const posts = [];
  const server = http.createServer((req, res) => {
    const u = req.url;
    const send = (code, type, body) => {
      res.writeHead(code, { "content-type": type });
      res.end(body);
    };
    if (u === "/" || u === "/index.html") return send(200, "text/html", PAGE);
    if (u === "/p2") return send(200, "text/html", PAGE2);
    if (u === "/boom") return send(200, "text/html", BOOM);
    if (u === "/throws-later") return send(200, "text/html", THROWS_LATER);
    if (u === "/slow") return setTimeout(() => send(200, "text/html", SLOW), 1500);
    if (u === "/blank") return send(200, "text/html", "");
    if (u === "/status500") return send(500, "text/html", "server error");
    if (u === "/missing.js") return send(404, "text/plain", "not found");
    if (u === "/needs-script") {
      // Page whose only script 404s -> exercises requestfailed
      return send(200, "text/html", `<!doctype html><html><body><h1>needs</h1><script src="/missing.js"></script></body></html>`);
    }
    if (u.startsWith("/api/")) return send(200, "application/json", JSON.stringify({ ok: true, path: u }));
    return send(404, "text/plain", "nope");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

// ─── Daemon lifecycle + RPC client ─────────────────────────────────────────

export async function withTempPiDir(fn) {
  const dir = join(REPO_ROOT, "test", `.tmp-pi-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Spawn a daemon against an isolated PI_CODING_AGENT_DIR and return a client.
 * `client.call(method, params)` speaks the daemon's wire format.
 */
export async function startDaemon(piDir, { config } = {}) {
  const runDir = join(piDir, "run");
  const socketPath = join(runDir, "aia-browser.sock");
  await mkdir(runDir, { recursive: true });
  await mkdir(join(piDir, "browser"), { recursive: true });
  await mkdir(join(piDir, "agent", "logs", "pi-aia-browser"), { recursive: true });

  // blockedHosts: [] so tests can reach 127.0.0.1 (the default blocklist
  // forbids loopback; tests need it and this is an isolated temp profile).
  await writeFile(
    join(piDir, "browser", "config.json"),
    JSON.stringify(config ?? { blockedHosts: [], headless: true, autoInit: true }),
  );

  const tsxLoader = resolveTsxLoader();
  const proc = spawn(
    process.execPath,
    ["--import", `file://${tsxLoader}`, DAEMON_SCRIPT],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, PI_CODING_AGENT_DIR: piDir },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );
  const stderrTail = [];
  proc.stderr.on("data", (c) => stderrTail.push(c.toString()));

  // Wait for the socket to appear.
  const deadline = Date.now() + 30000;
  while (!existsSync(socketPath)) {
    if (Date.now() > deadline) {
      throw new Error(`daemon did not start within 30s. stderr:\n${stderrTail.join("")}`);
    }
    await sleep(100);
  }

  const sock = connect(socketPath);
  await new Promise((res, rej) => {
    sock.once("connect", res);
    sock.once("error", rej);
  });

  let buf = "";
  let id = 0;
  const pending = new Map();
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = new Error(msg.error.message);
        e.code = msg.error.code;
        p.reject(e);
      } else {
        p.resolve(msg.result);
      }
    }
  });

  const call = (method, params, timeoutMs = 60000) =>
    new Promise((resolveP, rejectP) => {
      const reqId = ++id;
      const timer = setTimeout(() => {
        pending.delete(reqId);
        rejectP(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(reqId, { resolve: resolveP, reject: rejectP, timer });
      sock.write(JSON.stringify({ id: reqId, method, params }) + "\n");
    });

  // The socket appears before Chromium has finished launching and before the
  // initial page exists. Wait for a real page rather than racing it — this is
  // the same race the client's browser_init used to hit against autoInit.
  const readyDeadline = Date.now() + 30000;
  for (;;) {
    try {
      const p = await call("ping", {}, 5000);
      if (p.browserAlive && p.pages > 0 && p.activePage) break;
    } catch {
      // daemon not serving yet
    }
    if (Date.now() > readyDeadline) {
      throw new Error(
        `daemon never became ready (no active page within 30s). stderr:\n${stderrTail.join("")}`,
      );
    }
    await sleep(150);
  }

  return {
    proc,
    socketPath,
    logFile: join(piDir, "agent", "logs", "pi-aia-browser", "daemon.log"),
    call,
    stderrTail,
    async close() {
      try {
        await call("shutdown", {}, 5000);
      } catch {}
      try {
        sock.destroy();
      } catch {}
      try {
        proc.kill("SIGKILL");
      } catch {}
      await new Promise((r) => {
        if (proc.exitCode !== null) return r();
        proc.once("exit", r);
        setTimeout(r, 3000);
      });
    },
  };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `fn()` until truthy or timeout. Returns the truthy value or null. */
export async function waitFor(fn, { timeout = 8000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(interval);
  }
}
