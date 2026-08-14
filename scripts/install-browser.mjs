#!/usr/bin/env node
/**
 * pi-aia-browser postinstall — installs Playwright's Chromium browser.
 *
 * Runs automatically on `npm install` / `pi install npm:pi-aia-browser`.
 * Ensures the Chromium binary Playwright needs is present before first use,
 * so the extension works immediately after install.
 *
 * Skips silently when the binary is already present (fast re-installs).
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the playwright CLI installed as this package's dependency
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const candidates = [
  join(packageRoot, "node_modules", ".bin", "playwright"),
  join(packageRoot, "node_modules", "playwright", "cli.js"),
];
const playwrightCli = candidates.find((p) => existsSync(p));

if (!playwrightCli) {
  // Not fatal: pi installs with --legacy-peer-deps and lifecycle ordering can
  // vary. The extension also installs deps on first daemon launch.
  console.warn(
    "⚠ pi-aia-browser: playwright CLI not found yet — Chromium will be installed\n" +
      "  on first browser use, or run manually: npx playwright install chromium",
  );
  process.exit(0);
}

try {
  // `playwright install` is idempotent: it skips browsers already downloaded.
  execFileSync(process.execPath, [playwrightCli, "install", "chromium"], {
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "" },
  });
  console.log("✔ pi-aia-browser: Chromium ready.");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(
    "⚠ pi-aia-browser: automatic Chromium install failed — run manually:\n" +
      "  npx playwright install chromium\n" +
      `  (${msg.split("\n")[0]})`,
  );
  // Non-fatal: the extension checks at first launch and retries.
  process.exit(0);
}
