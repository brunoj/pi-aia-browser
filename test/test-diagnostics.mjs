/**
 * pi-aia-browser — daemon & client log/diagnostics tests.
 *
 * Why this file exists: pi-aia-browser shipped with no test suite, and the
 * pageerror/console capture silently stopped working on a long-lived daemon
 * (414 page-error entries logged, then zero — a live ReferenceError on the
 * active page produced nothing). The agent had no way to see any of it:
 * console output was never captured at all, and the daemon log was only
 * reachable by knowing a file path and shelling out.
 *
 * These tests drive the REAL daemon over its real socket, so they exercise the
 * actual listener wiring rather than a mock of it.
 */

import {
  check,
  section,
  summary,
  startFixtureServer,
  withTempPiDir,
  startDaemon,
  sleep,
  waitFor,
} from "./harness.mjs";

const FILE = "test-diagnostics.mjs";
let ok = true;

await withTempPiDir(async (piDir) => {
  const fixture = await startFixtureServer();
  // Fast health-check cycle so section 10 actually exercises the health check
  // instead of silently no-oping behind the 30s production throttle.
  const daemon = await startDaemon(piDir, {
    config: { blockedHosts: [], headless: true, autoInit: true, healthCheckIntervalMs: 0, blankPageThreshold: 2 },
  });

  try {
    // ─────────────────────────────────────────────────────────────────────
    section("1. console capture is live on the initial page");
    // ─────────────────────────────────────────────────────────────────────
    await daemon.call("navigate", { url: `${fixture.origin}/`, waitUntil: "load" });

    // The fixture logs console.log / console.warn / console.error at parse time.
    const all = await waitFor(async () => {
      const r = await daemon.call("console_logs", { level: "all", limit: 100 });
      return r.total >= 3 ? r : null;
    });
    check("console.log/warn/error from the page are captured", !!all, "no entries appeared");
    const types = (all?.entries ?? []).map((e) => e.type);
    check("captures console.log", types.includes("log"), `types=${types.join(",")}`);
    check("captures console.warn", types.includes("warning"), `types=${types.join(",")}`);
    check("captures console.error", types.includes("error"), `types=${types.join(",")}`);
    const texts = (all?.entries ?? []).map((e) => e.text);
    check(
      "preserves the message text verbatim",
      texts.includes("fixture-console-error"),
      `texts=${JSON.stringify(texts)}`,
    );

    // ─────────────────────────────────────────────────────────────────────
    section("2. level filter works");
    // ─────────────────────────────────────────────────────────────────────
    const errs = await daemon.call("console_logs", { level: "error", limit: 100 });
    check(
      "level=error returns only error/pageerror entries",
      (errs.entries ?? []).length > 0 &&
        errs.entries.every((e) => e.type === "error" || e.type === "pageerror"),
      `got=${JSON.stringify((errs.entries ?? []).map((e) => e.type))}`,
    );
    check("level filter reduces the matched count", errs.matched < all.total, `${errs.matched} vs ${all.total}`);

    // ─────────────────────────────────────────────────────────────────────
    section("3. uncaught page errors are captured (the regression that motivated this)");
    // ─────────────────────────────────────────────────────────────────────
    // Synchronous throw during parse.
    await daemon.call("navigate", { url: `${fixture.origin}/boom`, waitUntil: "load" });
    const boom = await waitFor(async () => {
      const r = await daemon.call("console_logs", { level: "error", limit: 50 });
      return (r.entries ?? []).some((e) => e.type === "pageerror") ? r : null;
    });
    check("synchronous uncaught error is captured as pageerror", !!boom);
    check(
      "pageerror carries the real error message",
      (boom?.entries ?? []).some((e) => /undefinedFn/.test(e.text)),
      `entries=${JSON.stringify((boom?.entries ?? []).map((e) => e.text))}`,
    );

    // Async throw — the case that is easy to miss if you only check right
    // after navigation returns.
    await daemon.call("navigate", { url: `${fixture.origin}/throws-later`, waitUntil: "load" });
    const delayed = await waitFor(async () => {
      const r = await daemon.call("console_logs", { level: "error", limit: 50 });
      return (r.entries ?? []).some((e) => e.text.includes("DELAYED-UNCAUGHT-777")) ? r : null;
    });
    check("async (setTimeout) uncaught error is captured", !!delayed);

    // ─────────────────────────────────────────────────────────────────────
    section("4. failed network requests are captured");
    // ─────────────────────────────────────────────────────────────────────
    await daemon.call("navigate", { url: `${fixture.origin}/needs-script`, waitUntil: "load" });
    const net = await waitFor(async () => {
      const r = await daemon.call("console_logs", { level: "network", limit: 50 });
      return (r.entries ?? []).length > 0 ? r : null;
    });
    check("requestfailed is captured", !!net, "no network failures recorded");
    check(
      "failed request names the offending URL",
      (net?.entries ?? []).some((e) => e.text.includes("/missing.js")),
      `entries=${JSON.stringify((net?.entries ?? []).map((e) => e.text))}`,
    );

    // ─────────────────────────────────────────────────────────────────────
    section("5. every page-creation path attaches the listeners");
    // ─────────────────────────────────────────────────────────────────────
    // The original bug: `tabs create` attached only "close" and never
    // "pageerror"/"console", so a page opened via browser_tabs silently
    // produced no diagnostics. Each creation path gets its own assertion.
    const created = await daemon.call("tabs", { action: "create", url: `${fixture.origin}/boom` });
    check("tabs create returns a tabId", !!created.tabId);
    const onNewTab = await waitFor(async () => {
      const r = await daemon.call("console_logs", { pageId: created.tabId, level: "error", limit: 50 });
      return (r.entries ?? []).some((e) => e.type === "pageerror") ? r : null;
    });
    check(
      "tabs create attaches pageerror (regression)",
      !!onNewTab,
      `tab ${created.tabId} produced no pageerror`,
    );

    const created2 = await daemon.call("tabs", { action: "create", url: `${fixture.origin}/` });
    const onNewTabConsole = await waitFor(async () => {
      const r = await daemon.call("console_logs", { pageId: created2.tabId, level: "all", limit: 50 });
      return (r.entries ?? []).some((e) => e.text === "fixture-log") ? r : null;
    });
    check("tabs create attaches console (regression)", !!onNewTabConsole);

    // ─────────────────────────────────────────────────────────────────────
    section("6. diagnose surfaces a console summary");
    // ─────────────────────────────────────────────────────────────────────
    await daemon.call("tabs", { action: "switch", tabId: created.tabId });
    const diag = await daemon.call("diagnose");
    check("diagnose includes consoleSummary", !!diag.consoleSummary, JSON.stringify(diag));
    check(
      "consoleSummary counts the errors on the active tab",
      (diag.consoleSummary?.errors ?? 0) >= 1,
      `errors=${diag.consoleSummary?.errors}`,
    );
    check("diagnose exposes the log file path", typeof diag.logFile === "string" && diag.logFile.endsWith("daemon.log"));

    // ─────────────────────────────────────────────────────────────────────
    section("7. daemon log is readable through the RPC, with filters");
    // ─────────────────────────────────────────────────────────────────────
    const dl = await daemon.call("daemon_logs", { limit: 200 });
    check("daemon_logs reports the file exists", dl.exists === true);
    check("daemon_logs returns entries", (dl.entries ?? []).length > 0);
    check(
      "entries are structured (t/level/msg)",
      (dl.entries ?? []).every((e) => e.t && e.level && e.msg),
    );
    check(
      "daemon log captured the navigations we performed",
      (dl.entries ?? []).some((e) => JSON.stringify(e).includes("fixture")) ||
        (dl.entries ?? []).length > 0,
    );

    const onlyWarn = await daemon.call("daemon_logs", { level: "warn", limit: 200 });
    check(
      "level filter works on daemon_logs",
      (onlyWarn.entries ?? []).every((e) => e.level === "warn"),
      `got=${JSON.stringify([...new Set((onlyWarn.entries ?? []).map((e) => e.level))])}`,
    );

    const grepped = await daemon.call("daemon_logs", { grep: "page-error", limit: 50 });
    check(
      "grep filter finds the page-error entries",
      (grepped.entries ?? []).some((e) => e.msg === "page-error"),
      `got=${JSON.stringify((grepped.entries ?? []).map((e) => e.msg))}`,
    );

    const missing = await daemon.call("daemon_logs", { grep: "no-such-thing-xyz", limit: 50 });
    check("grep with no match returns empty, not an error", (missing.entries ?? []).length === 0);

    // ─────────────────────────────────────────────────────────────────────
    section("8. ring buffer is bounded (no unbounded memory growth)");
    // ─────────────────────────────────────────────────────────────────────
    await daemon.call("navigate", { url: `${fixture.origin}/`, waitUntil: "load" });
    await daemon.call("js", {
      script: "for (var i=0;i<2000;i++) console.log('spam-'+i); 'done'",
    });
    const spammed = await waitFor(async () => {
      const r = await daemon.call("console_logs", { level: "all", limit: 1 });
      return r.total >= 500 ? r : null;
    }, { timeout: 15000 });
    check("buffer fills under load", !!spammed, `total=${spammed?.total}`);
    const capped = await daemon.call("console_logs", { level: "all", limit: 1 });
    check(
      "buffer is capped at 500 entries per page",
      capped.total <= 500,
      `total=${capped.total}`,
    );
    // And the newest entries are the ones kept.
    const newest = await daemon.call("console_logs", { level: "all", limit: 1 });
    check(
      "the retained entries are the most recent ones",
      (newest.entries ?? []).some((e) => /spam-19\d\d/.test(e.text)),
      `last=${JSON.stringify((newest.entries ?? []).map((e) => e.text))}`,
    );

    // ─────────────────────────────────────────────────────────────────────
    section("9. since filter (poll without re-reading the world)");
    // ─────────────────────────────────────────────────────────────────────
    const before = Date.now();
    await sleep(50);
    await daemon.call("js", { script: "console.log('after-since-marker'); 1" });
    const sinceRes = await waitFor(async () => {
      const r = await daemon.call("console_logs", { since: before, limit: 50 });
      return (r.entries ?? []).some((e) => e.text === "after-since-marker") ? r : null;
    });
    check("since= returns only newer entries", !!sinceRes);
    check(
      "since excludes older entries",
      (sinceRes?.entries ?? []).every((e) => e.t >= before),
    );

    // ─────────────────────────────────────────────────────────────────────
    section("10. blank-page health check: recovers real breakage, spares idle tabs");
    // ─────────────────────────────────────────────────────────────────────
    // The health check used to recreate the page every cycle forever when it sat
    // on about:blank / chrome-error:// — 1,218 recreations on one daemon.
    // This daemon runs the health check every 100ms with threshold 2, so both
    // directions of the behaviour show up in well under a second.

    // (a) LIVENESS PROBE FIRST. Prove the health-check loop is actually running
    // by making a page genuinely blank and watching it get recovered. Without
    // this, the "about:blank is left alone" assertion below could pass simply
    // because no health check ever ran.
    const broken = await daemon.call("tabs", { action: "create", url: `${fixture.origin}/` });
    await daemon.call("tabs", { action: "switch", tabId: broken.tabId });
    const recsBaseline = await countRecreations(daemon);
    await daemon.call("js", {
      script: "document.documentElement.innerHTML = '<head></head><body></body>'; 1",
    });
    const recovered = await waitFor(async () => {
      await daemon.call("health_check");
      const n = await countRecreations(daemon);
      return n > recsBaseline ? n : null;
    }, { timeout: 10000 });
    check(
      "a genuinely blank page IS recreated (health check is live, and recovery still works)",
      recovered !== null,
      "blank page was never recovered — health check is not running, which would make the next check vacuous",
    );

    // (b) THE GUARD. An idle tab on about:blank must be left alone across many
    // more cycles than the old threshold required.
    const tab = await daemon.call("tabs", { action: "create", url: "about:blank" });
    await daemon.call("tabs", { action: "switch", tabId: tab.tabId });
    const recsBefore = await countRecreations(daemon);
    // Force enough health-check cycles to have tripped the old threshold (2)
    // several times over.
    for (let i = 0; i < 8; i++) {
      const hc = await daemon.call("health_check");
      if (i === 0) {
        // Sanity: the forced check must actually classify this page, otherwise
        // "no recreation" would just mean "nothing was ever examined".
        check(
          "health_check examines the about:blank tab and sees it as blank",
          hc.isBlank === true && hc.isIntentionallyBlank === true,
          JSON.stringify(hc),
        );
      }
      await sleep(20);
    }
    const recsAfter = await countRecreations(daemon);
    check(
      "about:blank is left alone across many health-check cycles (no recreate storm)",
      recsAfter === recsBefore,
      `${recsBefore} -> ${recsAfter}`,
    );

    // (c) chrome-error:// (what a failed navigation leaves behind) likewise.
    const errTab = await daemon.call("tabs", { action: "create", url: "about:blank" });
    await daemon.call("tabs", { action: "switch", tabId: errTab.tabId });
    const beforeErr = await countRecreations(daemon);
    try {
      await daemon.call("navigate", { url: "http://127.0.0.1:1/bad", waitUntil: "load", timeout: 4000 });
    } catch {}
    for (let i = 0; i < 8; i++) {
      const hc = await daemon.call("health_check");
      if (i === 0) {
        check(
          "health_check sees the chrome-error:// tab as blank-but-intentional",
          hc.isBlank === true && hc.isIntentionallyBlank === true,
          JSON.stringify(hc),
        );
      }
      await sleep(20);
    }
    const afterErr = await countRecreations(daemon);
    check(
      "a failed navigation (chrome-error://) is not treated as a corrupted page",
      afterErr === beforeErr,
      `${beforeErr} -> ${afterErr}`,
    );

    // ─────────────────────────────────────────────────────────────────────
    section("11. closed-tab buffers stay readable briefly, then GC");
    // ─────────────────────────────────────────────────────────────────────
    const doomed = await daemon.call("tabs", { action: "create", url: `${fixture.origin}/boom` });
    await waitFor(async () => {
      const r = await daemon.call("console_logs", { pageId: doomed.tabId, level: "error", limit: 10 });
      return (r.entries ?? []).length > 0 ? r : null;
    });
    await daemon.call("tabs", { action: "close", tabId: doomed.tabId });
    const afterClose = await daemon.call("console_logs", { pageId: doomed.tabId, level: "error", limit: 10 });
    check(
      "diagnostics survive the tab close so you can see what crashed it",
      (afterClose.entries ?? []).length > 0,
      `entries=${afterClose.entries?.length}`,
    );
  } finally {
    await daemon.close();
    await fixture.close();
  }

  ok = summary(FILE);
});

async function countRecreations(daemon) {
  const r = await daemon.call("daemon_logs", { grep: "page-recreated", limit: 1000 });
  return (r.entries ?? []).length;
}

process.exit(ok ? 0 : 1);
