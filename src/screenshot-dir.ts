/**
 * Where the daemon writes screenshots.
 *
 * Extracted from daemon.ts so the hostile case can be unit-tested without
 * booting Playwright.
 *
 * The Unix default used to be the fixed path `/tmp/pi-aia-browser-screenshots`.
 * On a shared machine that is a footgun, not a convenience: /tmp is world
 * writable and the first user to create the directory owns it, so every other
 * user's daemon found it already present — `mkdir({recursive: true})` is
 * satisfied by an existing directory and reports no problem — and then died on
 * the write itself with `EACCES: permission denied`. The failure surfaced at
 * screenshot time, far from its cause, and took the whole client suite down
 * with it. A fixed name is also a squatting/symlink target.
 *
 * So the path carries the uid, and if even that candidate is not writable we
 * fall back to a private 0700 directory and keep working instead of failing
 * later on the first screenshot.
 */

import { mkdirSync, accessSync, mkdtempSync, constants } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

export interface ScreenshotDirOptions {
  /** Override the temp root (tests reproduce a hostile /tmp without a second account). */
  tmp?: string;
  /** Override the uid (tests simulate a foreign-owned candidate). */
  uid?: number | null;
  /** Override the env, for tests. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** The per-user home fallback, used on Windows and as the last resort. */
export function homeScreenshotDir(): string {
  const piDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi");
  return join(piDir, "browser", "screenshots");
}

/** True when `dir` exists and this process can create files inside it. */
export function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveScreenshotDir(opts: ScreenshotDirOptions = {}): string {
  const env = opts.env ?? process.env;
  const override = env.PI_AIA_BROWSER_SCREENSHOT_DIR;
  if (override) return override;
  if (process.platform === "win32") return homeScreenshotDir();

  const tmp = opts.tmp ?? tmpdir();
  // No process.uid in Node's types — getuid() is the POSIX accessor. When it is
  // absent we land on uid 0's name, which the writability check below already
  // covers, so a shared-machine collision still degrades to a private directory.
  const uid = opts.uid !== undefined
    ? opts.uid
    : (typeof process.getuid === "function" ? process.getuid() : 0);

  const candidate = join(tmp, `pi-aia-browser-screenshots-${uid}`);
  try {
    mkdirSync(candidate, { recursive: true, mode: 0o700 });
    if (isWritableDir(candidate)) return candidate;
  } catch {
    // exists and is not ours, or /tmp is unusual — fall through
  }
  try {
    return mkdtempSync(join(tmp, "pi-aia-browser-screenshots-"));
  } catch {
    return homeScreenshotDir();
  }
}
