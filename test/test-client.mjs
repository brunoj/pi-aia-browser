/**
 * pi-aia-browser — CLIENT layer regression suite.
 *
 * Everything in test-browser-core.mjs talks to the daemon directly over the
 * socket. That proves the daemon works, but it is NOT the path an agent
 * actually uses: the agent calls the registered pi tools (browser_navigate,
 * browser_click, ...) in index.ts, which do their own socket connection,
 * auto-spawn, and JSON-RPC framing.
 *
 * This suite loads the REAL index.ts under tsx, registers its tools against
 * a fake-but-faithful ExtensionAPI, points it at a daemon started by the test
 * harness (same socket path contract the extension itself uses via
 * PI_CODING_AGENT_DIR), and calls tool.execute() the way pi's tool runtime
 * would. No daemon mock, no tool-registration mock.
 */

import { check, section, summary, startFixtureServer, withTempPiDir, startDaemon, sleep, waitFor } from "./harness.mjs";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const FILE = "test-client.mjs";

function resolveTsxLoaderMjs() {
  const candidates = [join(REPO_ROOT, "node_modules", "tsx", "dist", "loader.mjs")];
  try {
    const g = execSync("npm root -g", { encoding: "utf8", timeout: 10000 }).trim();
    candidates.push(join(g, "tsx", "dist", "loader.mjs"));
  } catch {}
  try {
    const npxBase = join(process.env.HOME || "/home/brunoj", ".npm", "_npx");
    for (const hash of readdirSync(npxBase)) {
      const p = join(npxBase, hash, "node_modules", "tsx", "dist", "loader.mjs");
      if (existsSync(p)) candidates.push(p);
    }
  } catch {}
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`no tsx loader found, tried:\n${candidates.join("\n")}`);
  return found;
}

// Loading a .ts file via dynamic import() requires tsx's loader to be
// registered with `--import` at process startup — `module.register()` from
// inside the process is rejected ("must be loaded with --import instead of
// --loader"). So: if we're not already running under it, re-exec ourselves
// with the flag set, instead of asking every caller (run-all.sh, CI, a
// developer typing `node test/test-client.mjs`) to remember a magic flag.
if (!process.env.__PAB_TSX_REEXEC__) {
  const { spawnSync } = await import("node:child_process");
  const loader = resolveTsxLoaderMjs();
  const res = spawnSync(
    process.execPath,
    ["--import", `file://${loader}`, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit", env: { ...process.env, __PAB_TSX_REEXEC__: "1" } },
  );
  process.exit(res.status ?? 1);
}

/** Build a minimal but faithful fake of pi's ExtensionAPI surface. */
function makeFakeApi() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const api = {
    registerTool(def) {
      if (!def?.name) throw new Error("registerTool called without a name");
      tools.set(def.name, def);
    },
    registerCommand(name, def) {
      if (typeof def?.handler !== "function") {
        throw new Error(`registerCommand(${name}) has no handler function — violates the pi 1.0 contract`);
      }
      commands.set(name, def);
    },
    on(event, fn) {
      handlers.set(event, fn);
    },
  };
  return { api, tools, commands, handlers };
}

function makeFakeCtx() {
  const notifications = [];
  return {
    notifications,
    ui: {
      notify(msg, level) {
        notifications.push({ msg, level });
      },
    },
  };
}

let ok = true;

await withTempPiDir(async (piDir) => {
  const fixture = await startFixtureServer();
  // Start the real daemon the same way the extension's auto-spawn would end
  // up talking to it: same PI_CODING_AGENT_DIR, same socket path convention.
  const daemon = await startDaemon(piDir, { config: { blockedHosts: [], headless: true, autoInit: true } });

  const prevDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = piDir;
  try {
    // ─────────────────────────────────────────────────────────────────────
    section("1. module contract");
    // ─────────────────────────────────────────────────────────────────────
    const mod = await import(`${REPO_ROOT}/index.ts?t=${Date.now()}`);
    check("index.ts has a default export (activate function)", typeof mod.default === "function");

    const { api, tools, commands } = makeFakeApi();
    mod.default(api);

    check("registers browser_navigate", tools.has("browser_navigate"));
    check("registers browser_click", tools.has("browser_click"));
    check("registers browser_type", tools.has("browser_type"));
    check("registers browser_js", tools.has("browser_js"));
    check("registers browser_dom", tools.has("browser_dom"));
    check("registers browser_screenshot", tools.has("browser_screenshot"));
    check("registers browser_console (new diagnostics tool)", tools.has("browser_console"));
    check("registers browser_logs (new diagnostics tool)", tools.has("browser_logs"));
    check("registers the /browser command", commands.has("browser"));

    // pi 1.0 command contract: handler(args: string, ctx) => void, no return value relied on
    const browserCmd = commands.get("browser");
    check(
      "the /browser command handler matches the pi 1.0 contract shape",
      typeof browserCmd.handler === "function" && browserCmd.handler.length <= 2,
      `handler.length=${browserCmd.handler.length}`,
    );

    for (const [name, def] of tools) {
      check(`tool ${name} has a non-empty description`, typeof def.description === "string" && def.description.length > 10, name);
      check(`tool ${name} exposes execute()`, typeof def.execute === "function", name);
    }

    // ─────────────────────────────────────────────────────────────────────
    section("2. browser_init connects to (not re-spawns) the running daemon");
    // ─────────────────────────────────────────────────────────────────────
    const initRes = await tools.get("browser_init").execute("t1", {});
    const initText = initRes.content.map((c) => c.text).join("\n");
    check("browser_init reports success", /running|ready|already/i.test(initText) || initRes.details?.ok !== false, initText);

    // ─────────────────────────────────────────────────────────────────────
    section("3. navigate / dom / js through the real tool surface");
    // ─────────────────────────────────────────────────────────────────────
    const navRes = await tools.get("browser_navigate").execute("t2", { url: `${fixture.origin}/`, waitUntil: "load" });
    const navText = navRes.content.map((c) => c.text).join("\n");
    check("browser_navigate reports the fixture title", /Browser Fixture/.test(navText), navText);

    const domRes = await tools.get("browser_dom").execute("t3", { mode: "text" });
    const domText = domRes.content.map((c) => c.text).join("\n");
    check("browser_dom returns real page text", /Fixture/.test(domText), domText.slice(0, 100));

    const jsRes = await tools.get("browser_js").execute("t4", { script: "1+1" });
    const jsText = jsRes.content.map((c) => c.text).join("\n");
    check("browser_js evaluates and returns 2", /2/.test(jsText), jsText);

    // ─────────────────────────────────────────────────────────────────────
    section("4. type -> click -> observable change, via the tool surface");
    // ─────────────────────────────────────────────────────────────────────
    await tools.get("browser_type").execute("t5", { selector: "#inp", value: "via-client", clear: true });
    await tools.get("browser_click").execute("t6", { selector: "#btn" });
    const after = await waitFor(async () => {
      const r = await tools.get("browser_js").execute("t7", { script: "document.getElementById('out').textContent" });
      const text = r.content.map((c) => c.text).join("\n");
      return text.includes("clicked:via-client") ? text : null;
    });
    check("the click's effect is observable through the client tool path", after.includes("clicked:via-client"), after);

    // ─────────────────────────────────────────────────────────────────────
    section("5. browser_console / browser_logs — the newly captured diagnostics");
    // ─────────────────────────────────────────────────────────────────────
    await tools.get("browser_js").execute("t8", { script: "console.warn('client-path-probe'); 1" });
    const consoleRes = await waitFor(async () => {
      const r = await tools.get("browser_console").execute("t9", { level: "warning", limit: 20 });
      const text = r.content.map((c) => c.text).join("\n");
      return text.includes("client-path-probe") ? text : null;
    });
    check("browser_console surfaces a console.warn through the tool surface", consoleRes.includes("client-path-probe"), consoleRes.slice(0, 200));

    const logsRes = await tools.get("browser_logs").execute("t10", { limit: 20 });
    const logsText = logsRes.content.map((c) => c.text).join("\n");
    check("browser_logs returns something (daemon log is non-empty by now)", logsText.length > 0, logsText.slice(0, 100));

    // ─────────────────────────────────────────────────────────────────────
    section("6. screenshot through the tool surface produces a real file");
    // ─────────────────────────────────────────────────────────────────────
    const shotRes = await tools.get("browser_screenshot").execute("t11", {});
    const shotText = shotRes.content.map((c) => c.text).join("\n");
    const pathMatch = shotRes.details?.filepath || (shotText.match(/\/[^\s]+\.png/) || [])[0];
    check("browser_screenshot returns a path", !!pathMatch, shotText);
    check("the screenshot file actually exists on disk", !!pathMatch && existsSync(pathMatch), pathMatch);

    // ─────────────────────────────────────────────────────────────────────
    section("7. tabs through the tool surface");
    // ─────────────────────────────────────────────────────────────────────
    const tabsRes = await tools.get("browser_tabs").execute("t12", { action: "list" });
    const tabsText = tabsRes.content.map((c) => c.text).join("\n");
    check("browser_tabs list renders real titles, not the old '...' placeholder", !tabsText.includes(": ... —"), tabsText);
  } finally {
    process.env.PI_CODING_AGENT_DIR = prevDir;
    await daemon.close();
    await fixture.close();
  }

  ok = summary(FILE);
});

process.exit(ok ? 0 : 1);
