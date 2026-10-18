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
import { check, section, summary } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
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

const ok = summary(FILE);
process.exit(ok ? 0 : 1);
