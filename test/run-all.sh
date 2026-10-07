#!/usr/bin/env bash
# Run every pi-aia-browser test suite. Exits non-zero if any suite fails.
set -uo pipefail

cd "$(dirname "$0")"

suites=(
  test-browser-core.mjs
  test-diagnostics.mjs
  test-client.mjs
)

fail=0
for s in "${suites[@]}"; do
  echo "════════════════════════════════════════════════════════════"
  echo "▶ $s"
  echo "════════════════════════════════════════════════════════════"
  if node "$s"; then
    echo "✓ $s"
  else
    echo "✗ $s FAILED"
    fail=1
  fi
  echo
done

echo "────────────────────────────────────────────────────────────"
if [ "$fail" -eq 0 ]; then
  echo "ALL SUITES PASSED (${#suites[@]} suites)"
else
  echo "SOME SUITES FAILED"
fi
exit "$fail"
