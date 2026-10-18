/**
 * pi-aia-browser — packaging integrity.
 *
 * Why this exists: `package.json` used to ship `files: ["index.ts", "src/daemon.ts", …]`
 * — an explicit list. When `src/daemon.ts` gained `import "./screenshot-dir.ts"`, nothing
 * complained: typecheck passed (it reads the working tree), the whole suite passed (it runs
 * from the working tree), and `npm publish` succeeded. The published artifact simply did not
 * contain the file, so the daemon could not start on any machine that installed it. Only a
 * clean-room install caught it — after the release was already out.
 *
 * So the artifact itself is checked here, from the packument npm would build, not from the
 * working tree: every relative import in a shipped file must resolve to a file that is also
 * shipped.
 */
import { check, section, summary, sleep, resolveTsxLoader } from "./harness.mjs";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { join, dirname, resolve as rresolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = "test-packaging.mjs";
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
section("1 — the packed file set");
// ---------------------------------------------------------------------------
let packed = [];
let packErr = "";
try {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: REPO, encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024,
  });
  const json = JSON.parse(out);
  const entry = Array.isArray(json) ? json[0] : json;
  packed = (entry?.files ?? []).map((f) => (f.path || "").replace(/^\.\//, "")).filter(Boolean);
} catch (e) {
  packErr = String(e.stderr || e.message).slice(0, 400);
}

check("npm pack --dry-run succeeds", packErr === "", packErr);
check("the artifact is not empty", packed.length > 0, `${packed.length} files`);
check("the daemon entry point ships", packed.includes("src/daemon.ts"), packed.join(" "));
check("the client entry point ships", packed.includes("index.ts"), packed.join(" "));

const shipped = new Set(packed);

// ---------------------------------------------------------------------------
section("2 — every relative import inside the artifact resolves inside the artifact");
// ---------------------------------------------------------------------------
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)(["'])(\.\.?\/[^"']+?)\1/g;

const missing = [];
const checkedImports = [];
for (const rel of packed) {
  if (!/\.(ts|mts|js|mjs)$/.test(rel)) continue;
  const abs = join(REPO, rel);
  if (!existsSync(abs)) continue; // npm may normalise; the set check below covers it
  const text = readFileSync(abs, "utf8");
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[2];
    const target = rresolve(dirname(abs), spec);
    const relTarget = relative(REPO, target).replace(/\\/g, "/");
    checkedImports.push(`${rel} -> ${spec}`);
    // npm keeps the .ts extension in this package (pi loads .ts via jiti), but accept
    // the extensionless form too so the check does not become a second build system.
    const candidates = [relTarget, relTarget.replace(/\.ts$/, ""), `${relTarget}.ts`];
    if (!candidates.some((c) => shipped.has(c))) missing.push(`${rel}: ${spec}`);
  }
}

check("there were relative imports to check", checkedImports.length > 0,
  checkedImports.join(" | "));
check("no shipped file imports something the artifact omits",
  missing.length === 0, missing.join("\n  "));

// ---------------------------------------------------------------------------
section("3 — the files list is a directory, not a per-file whitelist");
// ---------------------------------------------------------------------------
{
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const files = pkg.files ?? [];
  const enumeratedSrc = files.filter((f) => /^src\/[^/]+$/.test(f));
  check(
    "src/ is shipped as a directory (an explicit file list silently drops new modules)",
    files.includes("src/") || files.includes("src"),
    `files: ${JSON.stringify(files)} — enumerated src entries: ${enumeratedSrc.join(", ") || "none"}`,
  );
  check("no individual src/*.ts file is enumerated instead",
    enumeratedSrc.length === 0, enumeratedSrc.join(", "));
}

// ---------------------------------------------------------------------------
section("4 — the module that broke the last release is present and loadable");
// ---------------------------------------------------------------------------
{
  check("src/screenshot-dir.ts ships",
    shipped.has("src/screenshot-dir.ts"),
    packed.filter((p) => p.startsWith("src/")).join(" "));
  const abs = join(REPO, "src", "screenshot-dir.ts");
  if (existsSync(abs)) {
    const text = readFileSync(abs, "utf8");
    check("it does not fall back to the shared fixed /tmp name",
      !/["']\/tmp\/pi-aia-browser-screenshots["']/.test(text),
      "a literal shared path is back");
  }
}

// ---------------------------------------------------------------------------
section("5 — the artifact installs clean-room and the daemon actually starts from it");
// ---------------------------------------------------------------------------
// Section 1-4 prove the tarball CONTAINS what the imports need. That is still a
// static argument. The defect that shipped once was only visible when someone
// installed the published package and tried to start the daemon, so this section
// does exactly that, reproducibly: pack a real tarball, install it into a fresh
// prefix, boot the INSTALLED src/daemon.ts and require it to answer the ping RPC.
//
// Isolation: the child runs with PI_CODING_AGENT_DIR pointed at a temp dir, so it
// uses its own socket/log/profile paths and cannot disturb a live daemon on the
// real socket. Teardown kills the one PID this test started — never a pattern kill.
{
  let tmp = null;
  let pid = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), "pab-cleanroom-"));
    const installDir = join(tmp, "install");
    const piHome = join(tmp, "pihome");
    mkdirSync(installDir, { recursive: true });
    mkdirSync(piHome, { recursive: true });

    let tarball = "";
    let packErr = "";
    try {
      const out = execFileSync("npm", ["pack", "--pack-destination", tmp, "--json"], {
        cwd: REPO, encoding: "utf8", timeout: 180000, maxBuffer: 32 * 1024 * 1024,
      });
      const j = JSON.parse(out);
      tarball = join(tmp, (Array.isArray(j) ? j[0] : j).filename);
    } catch (e) {
      packErr = String(e.stderr || e.message).slice(0, 300);
    }
    check("npm pack produces a real tarball", packErr === "" && existsSync(tarball), packErr || tarball);

    let installErr = "";
    try {
      // --ignore-scripts skips the postinstall Chromium download: this section is
      // about the package's own files and its module graph, not about browser bits.
      execFileSync(
        "npm", ["install", "--prefix", installDir, "--ignore-scripts", "--no-audit", "--no-fund", "--silent", tarball],
        { encoding: "utf8", timeout: 300000, maxBuffer: 32 * 1024 * 1024 },
      );
    } catch (e) {
      installErr = String(e.stderr || e.message).slice(0, 400);
    }
    check("the artifact installs clean-room from the tarball", installErr === "", installErr);

    const pkgDir = join(installDir, "node_modules", "pi-aia-browser");
    const absent = packed.filter((f) => !existsSync(join(pkgDir, f)));
    check("the installed copy contains every packed file", absent.length === 0, absent.join("\n  "));
    const installedDaemon = join(pkgDir, "src", "daemon.ts");
    check("the installed daemon entry point is present", existsSync(installedDaemon));

    let ping = null;
    let bootNote = "";
    if (existsSync(installedDaemon)) {
      const loader = resolveTsxLoader();
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
      pid = proc.pid;
      proc.unref();
      const stderrTail = [];
      proc.stderr?.on("data", (c) => stderrTail.push(c.toString()));

      const socketPath = join(piHome, "run", "aia-browser.sock");
      const deadline = Date.now() + 30000;
      while (!existsSync(socketPath) && Date.now() < deadline) await sleep(100);
      check(
        "the installed daemon opens its socket under its own PI_CODING_AGENT_DIR",
        existsSync(socketPath),
        `waited ${30000 - Math.max(0, deadline - Date.now())}ms; stderr: ${stderrTail.join("").slice(-260)}`,
      );

      if (existsSync(socketPath)) {
        const sock = createConnection(socketPath);
        try {
          await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
          ping = await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("ping timed out")), 10000);
            sock.on("data", (c) => {
              clearTimeout(t);
              const line = c.toString().split("\n").find((l) => l.trim());
              try { res(JSON.parse(line)); } catch (e) { rej(new Error(`unparsable reply: ${line}`)); }
            });
            sock.write(JSON.stringify({ id: 1, method: "ping", params: {} }) + "\n");
          });
        } catch (e) {
          bootNote = String(e.message || e);
        } finally {
          sock.destroy();
        }
      }
      check("the installed daemon answers the ping RPC", !!ping && !ping?.error, bootNote || JSON.stringify(ping ?? {}).slice(0, 200));
      check("the ping reply is a real daemon answer, not an error frame",
        ping?.result?.pong === true && typeof ping?.result?.uptime === "number",
        JSON.stringify(ping ?? {}).slice(0, 200));
      const daemonLog = join(piHome, "agent", "logs", "pi-aia-browser", "daemon.log");
      check("the installed daemon writes its log inside its own PI_CODING_AGENT_DIR",
        existsSync(daemonLog), daemonLog);
      // Pins a real defect: logSync() called require("fs"), which is undefined in
      // ESM under the tsx loader, and its empty catch hid it — the startup line,
      // and the uncaught-exception / daemon-crash lines an operator needs most,
      // were never written. Existence alone would pass on any stray write, so the
      // startup record itself is asserted.
      const logText = existsSync(daemonLog) ? readFileSync(daemonLog, "utf8") : "";
      check("the log records the daemon-started event (logSync really writes)",
        /"msg":"daemon-started"/.test(logText), logText.slice(0, 200) || "(no log file)");
    }
  } finally {
    // Ownership: this is the single PID this test spawned, recorded at launch.
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

const ok = summary(FILE);
process.exit(ok ? 0 : 1);
