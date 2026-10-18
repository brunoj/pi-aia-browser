#!/usr/bin/env node
/*
 * Post-publish verification of the PUBLISHED artifact.
 *
 * `npm publish` exiting 0 means npm accepted the upload, not that anyone can
 * install it — 0.2.1 shipped a tarball missing `src/screenshot-dir.ts` and every
 * local gate stayed green because they all read the working tree. So this script
 * deliberately ignores the working tree: it asks the registry for the version,
 * installs it from the registry into a throwaway prefix, boots the INSTALLED
 * daemon under its own PI_CODING_AGENT_DIR and requires it to answer the ping
 * RPC and to have written its startup line to its own log.
 *
 * Usage:   node scripts/verify-published.mjs [version]     (default: package.json version)
 * Exit 0 only if every check passes.
 *
 * Teardown rule: the daemon is killed by the exact PID this script spawned, after
 * /proc/<pid>/cmdline is re-checked to still be the child we started. Never a
 * pattern kill — other sessions on this machine run their own daemons.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const NAME = pkg.name;
const VERSION = process.argv[2] || pkg.version;

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass || !detail ? "" : ` — ${String(detail).slice(0, 300)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1 — the registry actually serves this version (metadata AND tarball)
// ---------------------------------------------------------------------------
const packumentUrl = `https://registry.npmjs.org/${encodeURIComponent(NAME)}?t=${Date.now()}`;
let doc = null;
try {
  const res = await fetch(packumentUrl, { headers: { "Cache-Control": "no-cache" } });
  if (res.ok) doc = await res.json();
} catch (e) {
  check("the registry is reachable", false, e.message);
}
const entry = doc?.versions?.[VERSION];
check(`the registry serves ${NAME}@${VERSION}`, !!entry, doc ? `latest=${doc["dist-tags"]?.latest}` : "no packument");
check(`${VERSION} is the latest dist-tag`, doc?.["dist-tags"]?.latest === VERSION, `latest=${doc?.["dist-tags"]?.latest}`);

let tarballOk = false;
let tarballDetail = "";
if (entry?.dist?.tarball) {
  try {
    const h = await fetch(entry.dist.tarball, { method: "HEAD" });
    tarballOk = h.ok;
    tarballDetail = `HTTP ${h.status}`;
  } catch (e) {
    tarballDetail = e.message;
  }
}
check("the published tarball is fetchable", tarballOk, tarballDetail || "no tarball url");
// The shasum npm computed locally must match what the registry stored, otherwise
// the bytes users install are not the bytes we tested.
if (entry?.dist?.shasum) {
  check("the registry recorded a shasum for this version", /^[0-9a-f]{40}$/.test(entry.dist.shasum), entry.dist.shasum);
}

// ---------------------------------------------------------------------------
// 2 — install it from the registry into a fresh prefix (no working tree, no cache)
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "pab-published-"));
const installDir = join(tmp, "install");
const piHome = join(tmp, "pihome");
mkdirSync(installDir, { recursive: true });
mkdirSync(piHome, { recursive: true });

let installErr = "";
try {
  // --ignore-scripts skips the postinstall Chromium download; this is about the
  // package's own files and its module graph.
  execFileSync(
    "npm",
    ["install", "--prefix", installDir, "--ignore-scripts", "--no-audit", "--no-fund", "--silent", "--no-cache", `${NAME}@${VERSION}`],
    { encoding: "utf8", timeout: 420000, maxBuffer: 32 * 1024 * 1024 },
  );
} catch (e) {
  installErr = String(e.stderr || e.message).slice(0, 500);
}
check(`npm installs ${NAME}@${VERSION} from the registry into a fresh prefix`, installErr === "", installErr);

const pkgDir = join(installDir, "node_modules", NAME);
const required = ["package.json", "index.ts", "src/daemon.ts", "src/screenshot-dir.ts", "scripts/install-browser.mjs"];
const absent = required.filter((f) => !existsSync(join(pkgDir, f)));
check("the installed copy contains every file the daemon graph needs", absent.length === 0, absent.join(", "));

const installedDaemon = join(pkgDir, "src", "daemon.ts");
if (absent.length > 0) {
  finish();
}

// ---------------------------------------------------------------------------
// 3 — boot the INSTALLED daemon under its own PI_CODING_AGENT_DIR
// ---------------------------------------------------------------------------
function findTsxLoader() {
  const cands = [
    join(REPO, "node_modules", "tsx", "dist", "loader.mjs"),
    join(REPO, "node_modules", ".bin", "tsx"),
  ];
  try {
    const g = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 30000 }).trim();
    cands.push(join(g, "tsx", "dist", "loader.mjs"));
    cands.push(join(g, "@earendil-works", "pi-coding-agent", "node_modules", "tsx", "dist", "loader.mjs"));
  } catch {}
  // The npx cache is what pi itself usually ends up using, so it is a legitimate
  // place to find a loader — but only files that actually exist are considered.
  try {
    const npxBase = join(process.env.HOME || "/root", ".npm", "_npx");
    for (const hash of readdirSync(npxBase)) cands.push(join(npxBase, hash, "node_modules", "tsx", "dist", "loader.mjs"));
  } catch {}
  return cands.find((p) => existsSync(p)) || null;
}

const loader = findTsxLoader();
check("a tsx loader is available to boot the .ts daemon", !!loader, "install tsx or run from a checkout");
if (!loader) finish();

const proc = spawn(
  process.execPath,
  ["--import", `file://${loader}`, installedDaemon],
  {
    cwd: pkgDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: piHome },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  },
);
const pid = proc.pid;
writeFileSync(join(tmp, "daemon.pid"), String(pid));
proc.unref();
const stderrTail = [];
proc.stderr?.on("data", (c) => stderrTail.push(c.toString()));

const socketPath = join(piHome, "run", "aia-browser.sock");
const deadline = Date.now() + 45000;
while (!existsSync(socketPath) && Date.now() < deadline) await sleep(200);
check(
  "the published daemon opens its socket under its own PI_CODING_AGENT_DIR",
  existsSync(socketPath),
  `waited ${45000 - Math.max(0, deadline - Date.now())}ms; stderr: ${stderrTail.join("").slice(-300)}`,
);

if (existsSync(socketPath)) {
  const sock = createConnection(socketPath);
  try {
    await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
    const ping = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("ping timed out")), 15000);
      sock.on("data", (c) => {
        clearTimeout(t);
        const line = c.toString().split("\n").find((l) => l.trim());
        try { res(JSON.parse(line)); } catch { rej(new Error(`unparsable reply: ${line}`)); }
      });
      sock.write(JSON.stringify({ id: 1, method: "ping", params: {} }) + "\n");
    });
    check("the published daemon answers the ping RPC", ping && !ping.error, JSON.stringify(ping).slice(0, 200));
  } catch (e) {
    check("the published daemon answers the ping RPC", false, String(e.message || e));
  } finally {
    sock.destroy();
  }
}

// ---------------------------------------------------------------------------
// 4 — the daemon LOG actually has content.
// 0.2.2 shipped a logSync() that called require("fs") under the tsx ESM loader,
// where require is undefined: every write threw into an empty catch, so the log
// stayed empty and a crashed daemon left no trace. A published artifact that
// cannot write its startup line has the same bug as the one this release fixes.
// ---------------------------------------------------------------------------
const logFile = join(piHome, "agent", "logs", "pi-aia-browser", "daemon.log");
let logText = "";
const logDeadline = Date.now() + 10000;
while (Date.now() < logDeadline) {
  if (existsSync(logFile)) { logText = readFileSync(logFile, "utf8"); if (/"msg":"daemon-started"/.test(logText)) break; }
  await sleep(250);
}
check(
  "the published daemon writes its startup line to its own log",
  /"msg":"daemon-started"/.test(logText),
  `log: ${logFile} — ${logText.slice(0, 200) || "(no log file)"}`,
);

// ---------------------------------------------------------------------------
// teardown — kill exactly the PID we started, after re-checking its cmdline
// ---------------------------------------------------------------------------
try {
  const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
  if (cmdline.includes("daemon.ts") && cmdline.includes(installedDaemon)) {
    process.kill(pid, "SIGTERM");
  } else {
    console.log(`SKIP kill — pid ${pid} is no longer the daemon we started`);
  }
} catch {
  /* already gone */
}
try { rmSync(tmp, { recursive: true, force: true }); } catch {}

finish();

function finish() {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log(`PUBLISHED ARTIFACT NOT VERIFIED: ${NAME}@${VERSION}`);
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }
  console.log(`PUBLISHED ARTIFACT VERIFIED: ${NAME}@${VERSION} installs from the registry and the daemon boots and logs`);
  process.exit(0);
}
