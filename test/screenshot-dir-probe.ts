/**
 * Probe used by test-screenshot-dir.mjs: imports the real TypeScript module
 * under the same tsx loader the daemon runs under, calls the resolver with the
 * options handed in, and prints the result as JSON.
 *
 * Kept separate so the suite itself can run under plain `node` (run-all.sh)
 * while still exercising the actual shipped module rather than a copy.
 */
import { resolveScreenshotDir } from "../src/screenshot-dir.ts";

const opts = JSON.parse(process.argv[2] ?? "{}") as {
  tmp?: string;
  uid?: number | null;
};

try {
  process.stdout.write(JSON.stringify({ ok: true, dir: resolveScreenshotDir(opts) }));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(err) }));
}
