#!/usr/bin/env bash
# pi-aia-browser release script — auto-version + changelog + tag + push + publish.
#
# Usage:   npm run release [patch|minor|major]   (default: patch)
# Requires: npm login (done once), git remote configured, gh CLI for PR-less push
#   or a configured git remote with push access.
set -euo pipefail

LEVEL="${1:-patch}"
case "$LEVEL" in
  patch|minor|major) ;;
  *) echo "Usage: npm run release [patch|minor|major]" >&2; exit 1 ;;
esac

# Must be run from the repo root
cd "$(dirname "$0")/.."

# Sanity checks
[ -f package.json ] || { echo "package.json not found" >&2; exit 1; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repo" >&2; exit 1; }
git diff --quiet || { echo "working tree dirty — commit or stash first" >&2; exit 1; }
npm whoami >/dev/null 2>&1 || { echo "not logged in to npm — run 'npm login' first" >&2; exit 1; }

# Gate the release on the full suite. A release script that publishes whatever
# is in the tree is how a broken artifact reaches users — and this package
# already has one packaging bug in its history (0.1.0 shipped a broken `files`
# allowlist), so "it worked for me locally" is not evidence.
echo "▶ running the full test suite before releasing..."
npm test
echo "▶ typechecking..."
npm run check

OLD_VERSION=$(node -p "require('./package.json').version")
NEW_VERSION=$(npm version "$LEVEL" --no-git-tag-version)

# Update changelog: insert new version section under [Unreleased]
TODAY=$(date +%Y-%m-%d)
node - "$NEW_VERSION" "$TODAY" <<'EOF'
const fs = require('fs');
const [v, today] = process.argv.slice(2);
const vv = v.replace(/^v/, '');
let cl = fs.readFileSync('CHANGELOG.md', 'utf-8');
if (!cl.includes(`## [${vv}]`)) {
  const entry = `## [${vv}] - ${today}\n\n### Added\n\n- (describe changes for ${vv})\n\n`;
  cl = cl.replace('## [Unreleased]\n', `## [Unreleased]\n\n${entry}`);
  fs.writeFileSync('CHANGELOG.md', cl);
}
EOF

git add package.json CHANGELOG.md
[ -f package-lock.json ] && git add package-lock.json
git commit -m "chore: release $NEW_VERSION"
# Annotated on purpose: `git push --follow-tags` only pushes annotated tags, so a
# lightweight tag here would leave the release untagged on GitHub.
git tag -a "$NEW_VERSION" -m "Release $NEW_VERSION"

# Push and publish
git push --follow-tags
git push origin "$NEW_VERSION"
npm publish

# Gate: the publish actually landed. `npm publish` exits 0 when npm ACCEPTS the
# upload, but npm can hold a version in its staging queue and serve the packument
# before the tarball exists — so a release nobody could install printed the same
# success banner as a real one (this happened to pi-vigilant 0.8.0: `npm install
# pi-aia-browser@<v>` failed with ETARGET while the script said ✅). A tag and a
# commit are not a release, so poll the registry for the version itself.
echo "── gate: publish landed ─────────────────────────────────────"
PKG_NAME=$(node -p "require('./package.json').name")
node - "$PKG_NAME" "${NEW_VERSION#v}" <<'EOF' || exit 1
const [name, version] = process.argv.slice(2);
const tarball = `https://registry.npmjs.org/${encodeURIComponent(name)}/-/${name}-${version}.tgz`;
const url = `https://registry.npmjs.org/${encodeURIComponent(name)}?t=${Date.now()}`;
const landed = async () => {
  try {
    const res = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
    if (!res.ok) return false;
    const doc = await res.json();
    if (!doc.versions?.[version]) return false;
    // The metadata listing the version is not enough — the tarball has to be
    // fetchable, which is exactly what an install needs.
    const t = await fetch(tarball, { method: "HEAD" });
    return t.ok;
  } catch {
    return false;
  }
};
// npm routinely holds a fresh publish in its staging queue for several minutes
// before the tarball is installable. A 240s window called two real releases
// "INCOMPLETE" while the version was in fact live minutes later, so the window has
// to be wider than npm's usual staging delay.
const DEADLINE = Date.now() + 1_200_000;
const START = Date.now();
(async () => {
  let attempt = 0;
  while (Date.now() < DEADLINE) {
    attempt++;
    if (await landed()) {
      console.log(`published: ${name}@${version} is installable from the registry`);
      return;
    }
    // Say something while waiting: a silent 20 minutes looks like a hung script.
    if (attempt % 6 === 0) console.log(`  waiting for npm to serve ${name}@${version} — ${Math.round((Date.now() - START) / 1000)}s`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
  console.error(
    `release INCOMPLETE: ${name}@${version} is not installable after 20 minutes.\n` +
      `npm most likely holds it in its staging queue (security review), or rejected it.\n` +
      `The git tag exists but nobody can install this version — check\n` +
      `https://www.npmjs.com/package/${name} and the security-holds page, then\n` +
      `re-publish (a still-staged version cannot be re-published: it 409s).`,
  );
  process.exit(1);
})();
EOF

# Gate: the PUBLISHED artifact, not the local tree. Every other gate in this
# script reads the working tree, which is exactly how 0.2.1 shipped a tarball
# missing src/screenshot-dir.ts with a green suite. This one installs the version
# from the registry into a throwaway prefix, boots the installed daemon under its
# own PI_CODING_AGENT_DIR and requires it to answer ping AND to have written its
# startup line — the logSync bug that 0.2.3 fixes is invisible to every local test.
if [ "${BMX_SKIP_PUBLISHED_VERIFY:-}" != "1" ]; then
  echo "── gate: published artifact verified ─────────────────────────"
  node scripts/verify-published.mjs "${NEW_VERSION#v}" || {
    echo "release INCOMPLETE: ${NEW_VERSION} is on the registry but the installed artifact does not work" >&2
    exit 1
  }
fi

echo ""
echo "✅ Released $OLD_VERSION → $NEW_VERSION"
echo "   Tag:   $NEW_VERSION"
echo "   npm:   npm:pi-aia-browser@$NEW_VERSION"
echo "   NOTE:  Update CHANGELOG.md's '### Added' section if needed, then commit."
