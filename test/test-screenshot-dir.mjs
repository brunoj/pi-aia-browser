/**
 * pi-aia-browser — screenshot directory resolution.
 *
 * Guards a real production failure: the Unix screenshot directory used to be
 * the fixed path `/tmp/pi-aia-browser-screenshots`. /tmp is world writable, so
 * on a shared machine the first user to create it owns it, and every other
 * user's daemon passed `mkdir({recursive: true})` (an existing directory
 * satisfies it), reported nothing wrong, and then died on the first screenshot
 * with `EACCES: permission denied` — which took the whole client suite down.
 *
 * The hostile case is reproduced without needing a second account by creating
 * the candidate ourselves and taking write permission away: "the directory
 * exists but we cannot write in it" is exactly the state that used to slip
 * through to screenshot time.
 */
import { check, section, summary, resolveTsxLoader } from "./harness.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, chmodSync, rmSync, existsSync, statSync, accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const FILE = "test-screenshot-dir.mjs";
const REPO = path.dirname(fileURLToPath(import.meta.url));
const PROBE = join(REPO, "screenshot-dir-probe.ts");
const LOADER = resolveTsxLoader();
const UID = typeof process.getuid === "function" ? process.getuid() : 0;

if (!LOADER) {
  console.log("SKIP  cannot resolve the tsx loader — cannot load the .ts module");
  process.exit(1);
}

/** Run the real resolver (imported from src/, not copied) in a child process. */
function resolve(opts = {}, env = {}) {
  const res = spawnSync(
    process.execPath,
    ["--import", `file://${LOADER}`, PROBE, JSON.stringify(opts)],
    { encoding: "utf8", env: { ...process.env, ...env }, timeout: 30000 },
  );
  if (res.status !== 0) {
    return { ok: false, error: `probe exited ${res.status}: ${res.stderr?.slice(0, 300)}` };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { ok: false, error: `probe printed non-JSON: ${res.stdout.slice(0, 200)}` };
  }
}

const writable = (dir) => {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const sandboxes = [];
const sandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), "pv-screenshot-dir-"));
  sandboxes.push(dir);
  return dir;
};

// ---------------------------------------------------------------------------
section("1 — the default is per-user, created, and private");
// ---------------------------------------------------------------------------
{
  const tmp = sandbox();
  const r = resolve({ tmp, uid: UID });
  check("resolver succeeds", r.ok === true, r.error ?? "");
  check("the path carries the uid (no shared, pre-emptable name)",
    r.dir === join(tmp, `pi-aia-browser-screenshots-${UID}`), `${r.dir}`);
  check("it is never the legacy fixed name",
    r.dir !== "/tmp/pi-aia-browser-screenshots", `${r.dir}`);
  check("the directory exists", existsSync(r.dir));
  check("we can write in it", writable(r.dir));
  const mode = existsSync(r.dir) ? statSync(r.dir).mode & 0o777 : 0;
  check("it is private (0700), not group/other-writable", mode === 0o700, mode.toString(8));
}

// ---------------------------------------------------------------------------
section("2 — a pre-existing candidate we cannot write in must be abandoned");
// ---------------------------------------------------------------------------
{
  const tmp = sandbox();
  const hostile = join(tmp, `pi-aia-browser-screenshots-${UID}`);
  // The exact production state: the directory is there, mkdir(recursive) is
  // happy with it, and the failure only appears when a file is opened.
  mkdirSync(hostile, { recursive: true });
  chmodSync(hostile, 0o500);
  check("fixture really is unwritable (otherwise this test proves nothing)",
    !writable(hostile), "the hostile directory is writable — fixture is vacuous");

  const r = resolve({ tmp, uid: UID });
  check("resolver succeeds anyway", r.ok === true, r.error ?? "");
  check("it does NOT hand back the unwritable directory",
    r.dir !== hostile, `returned ${r.dir}`);
  check("the path it does return is writable", writable(r.dir), `${r.dir}`);

  // A screenshot must actually land — that is what used to throw EACCES.
  const probe = join(r.dir, "shot.png");
  const wrote = spawnSync(process.execPath, ["-e",
    `require('node:fs').writeFileSync(${JSON.stringify(probe)}, 'x')`],
    { encoding: "utf8" });
  check("a file can actually be written there (the call that used to EACCES)",
    wrote.status === 0 && existsSync(probe), wrote.stderr?.slice(0, 200) ?? "");

  chmodSync(hostile, 0o700); // so the sandbox can be removed
}

// ---------------------------------------------------------------------------
section("3 — the operator override still wins");
// ---------------------------------------------------------------------------
{
  const tmp = sandbox();
  const chosen = join(tmp, "operator-choice");
  const r = resolve({ tmp, uid: UID }, { PI_AIA_BROWSER_SCREENSHOT_DIR: chosen });
  check("PI_AIA_BROWSER_SCREENSHOT_DIR is honoured verbatim",
    r.dir === chosen, `${r.dir}`);
}

// ---------------------------------------------------------------------------
section("4 — no uid accessor still degrades safely, never to a shared name");
// ---------------------------------------------------------------------------
{
  const tmp = sandbox();
  const r = resolve({ tmp, uid: 0 });
  check("resolver succeeds without a real uid", r.ok === true, r.error ?? "");
  check("result is writable", writable(r.dir), `${r.dir}`);
  check("still not the legacy fixed name", r.dir !== "/tmp/pi-aia-browser-screenshots");
}

for (const dir of sandboxes) {
  try {
    chmodSync(join(dir, `pi-aia-browser-screenshots-${UID}`), 0o700);
  } catch {}
  rmSync(dir, { recursive: true, force: true });
}

const ok = summary(FILE);
process.exit(ok ? 0 : 1);
