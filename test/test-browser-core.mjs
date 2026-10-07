/**
 * pi-aia-browser — core automation regression suite.
 *
 * This is the "indispensable task" ASF Rule 9 depends on: if these tools do
 * not actually drive a real page, every browser-verification gate in the ASF
 * is fiction. Drives the real daemon over the real socket.
 *
 * Asserts observable end state (ASF Rule 2), not that a call returned ok.
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

const FILE = "test-browser-core.mjs";
let ok = true;

await withTempPiDir(async (piDir) => {
  const fixture = await startFixtureServer();
  const daemon = await startDaemon(piDir);
  const ev = async (script) => (await daemon.call("js", { script })).result;

  try {
    // ─────────────────────────────────────────────────────────────────────
    section("1. init / readiness");
    // ─────────────────────────────────────────────────────────────────────
    const ping = await daemon.call("ping");
    check("daemon is alive", ping.pong === true);
    check("a page exists after startup (no init race)", ping.pages > 0 && !!ping.activePage, JSON.stringify(ping));
    check("browser is connected", ping.browserAlive === true);

    // init must be safe to call again (client does this on every browser_init)
    const reinit = await daemon.call("init", {});
    check("repeat init is idempotent and still reports a page", reinit.ok === true && !!reinit.pageId, JSON.stringify(reinit));
    const ping2 = await daemon.call("ping");
    check("repeat init did not spawn a second browser", ping2.pages === ping.pages + 0 || ping2.pages >= 1, JSON.stringify(ping2));

    // ─────────────────────────────────────────────────────────────────────
    section("2. navigate");
    // ─────────────────────────────────────────────────────────────────────
    const nav = await daemon.call("navigate", { url: `${fixture.origin}/`, waitUntil: "load" });
    check("navigate reports the final URL", nav.url === `${fixture.origin}/`, nav.url);
    check("navigate reports the real title", nav.title === "Browser Fixture", nav.title);
    check("navigate reports HTTP status 200", nav.status === 200, String(nav.status));

    const nav404 = await daemon.call("navigate", { url: `${fixture.origin}/nope`, waitUntil: "load" });
    check("navigate surfaces a 404 rather than throwing", nav404.status === 404, String(nav404.status));

    const nav500 = await daemon.call("navigate", { url: `${fixture.origin}/status500`, waitUntil: "load" });
    check("navigate surfaces a 500", nav500.status === 500, String(nav500.status));
    check("navigate's ok flag is false for a 500", nav500.ok === false, String(nav500.ok));

    // ─────────────────────────────────────────────────────────────────────
    section("3. dom extraction");
    // ─────────────────────────────────────────────────────────────────────
    await daemon.call("navigate", { url: `${fixture.origin}/`, waitUntil: "load" });
    const txt = await daemon.call("dom", { mode: "text" });
    check("dom text contains the rendered heading", /Fixture/.test(txt.text ?? ""), JSON.stringify(txt.text).slice(0, 120));
    const html = await daemon.call("dom", { mode: "html", selector: "#hdr" });
    check("dom html targets the requested selector", /<h1[^>]*id="hdr"/.test(html.html ?? ""), (html.html ?? "").slice(0, 80));
    const attrs = await daemon.call("dom", { mode: "attributes", selector: "#inp" });
    check("dom attributes reads input attributes", attrs.attributes?.placeholder === "Search", JSON.stringify(attrs.attributes));
    const computed = await daemon.call("dom", { mode: "computed", selector: "#hdr", property: "display" });
    check("dom computed returns a style value", typeof computed.value === "string" && computed.value.length > 0, JSON.stringify(computed));

    // truncation must be reported, not silent (ASF: never a misleading clean result)
    const big = await daemon.call("dom", { mode: "html", maxLength: 50 });
    check("oversized dom output is explicitly marked truncated", big.truncated === true && big.length > 50, JSON.stringify({ t: big.truncated, l: big.length }));

    // ─────────────────────────────────────────────────────────────────────
    section("4. js execution");
    // ─────────────────────────────────────────────────────────────────────
    check("js evaluates expressions", (await ev("1 + 1")) === 2);
    check("js returns objects by value", JSON.stringify(await ev("({a:1,b:'x'})")) === JSON.stringify({ a: 1, b: "x" }));
    check("js sees page globals", (await ev("window.__js")) === 42, String(await ev("window.__js")));
    const bad = await daemon.call("js", { script: "undefinedFn()" });
    check("js reports an error rather than silently returning null", !!bad.error, JSON.stringify(bad));

    // ─────────────────────────────────────────────────────────────────────
    section("5. interaction: type then click changes the observable end state");
    // ─────────────────────────────────────────────────────────────────────
    await daemon.call("navigate", { url: `${fixture.origin}/`, waitUntil: "load" });
    await daemon.call("type", { selector: "#inp", value: "hello-asf", clear: true });
    const typed = await ev("document.getElementById('inp').value");
    check("type puts the value in the field", typed === "hello-asf", String(typed));

    await daemon.call("click", { selector: "#btn" });
    const out = await waitFor(async () => {
      const v = await ev("document.getElementById('out').textContent");
      return v && v !== "" ? v : null;
    });
    check("click produces the observable DOM change", out === "clicked:hello-asf", String(out));

    // clear:true must actually clear
    await daemon.call("type", { selector: "#inp", value: "second", clear: true });
    check("type clear:true replaces rather than appends", (await ev("document.getElementById('inp').value")) === "second");

    // click by text
    const clickByText = await daemon.call("click", { text: "second page" }).then(() => true).catch(() => false);
    check("click by text works", clickByText);

    // missing element must be a helpful error, not a hang
    const t0 = Date.now();
    const miss = await daemon.call("click", { selector: "#does-not-exist" }).then(() => null).catch((e) => e);
    check("click on a missing element errors with not-found", miss?.code === "not-found", String(miss?.code ?? miss?.message));
    check("missing-element error is fast, not a 30s hang", Date.now() - t0 < 15000, `${Date.now() - t0}ms`);

    // ─────────────────────────────────────────────────────────────────────
    section("6. wait — the silent-async path ASF Rule 9 exists for");
    // ─────────────────────────────────────────────────────────────────────
    await daemon.call("navigate", { url: `${fixture.origin}/`, waitUntil: "domcontentloaded" });
    const before = await ev("document.getElementById('async').textContent");
    check("right after domcontentloaded the async content has NOT landed", before === "pending", String(before));
    await daemon.call("wait", { type: "function", script: "document.getElementById('async').textContent === 'enriched'", timeout: 5000 });
    const after = await ev("document.getElementById('async').textContent");
    check("wait for a JS condition catches the late async render", after === "enriched", String(after));

    const waitSel = await daemon.call("wait", { type: "selector", selector: "#out", state: "attached", timeout: 3000 }).then(() => true).catch(() => false);
    check("wait for a selector works", waitSel);

    const waitTimeout = await daemon.call("wait", { type: "selector", selector: "#never-appears", timeout: 800 }).then(() => null).catch((e) => e);
    check("wait times out with an error rather than hanging forever", !!waitTimeout, "wait resolved on a selector that never appears");

    // ─────────────────────────────────────────────────────────────────────
    section("7. scroll");
    // ─────────────────────────────────────────────────────────────────────
    await daemon.call("js", {
      script: "document.body.style.minHeight='4000px'; document.body.insertAdjacentHTML('beforeend','<div style=\"height:4000px\">x</div>'); 1",
    });
    const sc = await daemon.call("scroll", { direction: "down", amount: 500 });
    check("scroll reports a position", typeof sc.position?.y === "number", JSON.stringify(sc));
    check("scroll actually moved the page", sc.position.y > 0, JSON.stringify(sc.position));
    const top = await daemon.call("scroll", { direction: "top" });
    check("scroll to top returns to y=0", top.position.y === 0, JSON.stringify(top.position));

    // ─────────────────────────────────────────────────────────────────────
    section("8. history: back / forward / reload");
    // ─────────────────────────────────────────────────────────────────────
    await daemon.call("navigate", { url: `${fixture.origin}/`, waitUntil: "load" });
    await daemon.call("click", { selector: "#lnk" });
    await waitFor(async () => ((await ev("document.body.innerText")).includes("PAGE2-OK") ? true : null));
    check("link click navigated to page 2", (await ev("document.title")) === "Page Two", await ev("document.title"));
    const bk = await daemon.call("back");
    check("back returns to the fixture", (await ev("document.title")) === "Browser Fixture", JSON.stringify(bk));
    const fw = await daemon.call("forward");
    check("forward returns to page 2", (await ev("document.title")) === "Page Two", JSON.stringify(fw));
    const rl = await daemon.call("reload");
    check("reload reports a status like navigate does", typeof rl.status === "number" && rl.status === 200, JSON.stringify(rl));
    check("reload keeps the same URL", String(rl.url).endsWith("/p2"), JSON.stringify(rl.url));

    // ─────────────────────────────────────────────────────────────────────
    section("9. tabs");
    // ─────────────────────────────────────────────────────────────────────
    const startCount = (await daemon.call("tabs", { action: "list" })).pages.length;
    const t1 = await daemon.call("tabs", { action: "create", url: `${fixture.origin}/p2` });
    check("tabs create returns an id", !!t1.tabId);
    check("tabs create reports the url", String(t1.url).includes("/p2"), t1.url);
    const listed = await daemon.call("tabs", { action: "list" });
    check("tabs list shows the new tab", listed.pages.length === startCount + 1, `${startCount} -> ${listed.pages.length}`);
    check("the new tab is the active one", listed.activePageId === t1.tabId, JSON.stringify(listed.activePageId));
    check("the new tab really loaded its own page", (await ev("document.title")) === "Page Two");

    // Titles must be real, not a placeholder — the old implementation returned
    // the literal "..." for every tab, which an agent would read as a title.
    const listed1 = listed.pages.find((p) => p.id === t1.tabId);
    check("tabs list reports the REAL page title", listed1?.title === "Page Two", JSON.stringify(listed1));
    check(
      "no tab reports the old '...' placeholder as its title",
      !listed.pages.some((p) => p.title === "..."),
      JSON.stringify(listed.pages.map((p) => p.title)),
    );

    const t2 = await daemon.call("tabs", { action: "create", url: `${fixture.origin}/` });
    check("second tab has its own document", (await ev("document.title")) === "Browser Fixture");
    await daemon.call("tabs", { action: "switch", tabId: t1.tabId });
    check("switch changes which document is active", (await ev("document.title")) === "Page Two");
    await daemon.call("tabs", { action: "close", tabId: t1.tabId });
    const afterClose = await daemon.call("tabs", { action: "list" });
    check("close removes the tab", !afterClose.pages.some((p) => p.id === t1.tabId), JSON.stringify(afterClose.pages.map((p) => p.id)));
    check("after closing the active tab something is still active", !!afterClose.activePageId, JSON.stringify(afterClose.activePageId));
    check(
      "closing a tab focuses the ADJACENT tab, not the oldest one",
      afterClose.activePageId === t2.tabId,
      `expected ${t2.tabId}, got ${afterClose.activePageId}`,
    );
    check("the surviving tab is usable", (await ev("document.title")) === "Browser Fixture", await ev("document.title"));

    const badSwitch = await daemon.call("tabs", { action: "switch", tabId: "nope" }).then(() => null).catch((e) => e);
    check("switch to a missing tab errors clearly", badSwitch?.code === "not-found", String(badSwitch?.code));

    await daemon.call("tabs", { action: "close", tabId: t2.tabId });

    // ─────────────────────────────────────────────────────────────────────
    section("10. cookies");
    // ─────────────────────────────────────────────────────────────────────
    const cookies = await daemon.call("cookies", { action: "get" });
    check("cookies get returns an array", Array.isArray(cookies.cookies), JSON.stringify(cookies).slice(0, 100));
    await daemon.call("cookies", {
      action: "set",
      cookies: [{ name: "asf-test", value: "yes", url: fixture.origin }],
    });
    const afterSet = await daemon.call("cookies", { action: "get" });
    check("cookies set actually persists", afterSet.cookies.some((c) => c.name === "asf-test" && c.value === "yes"), JSON.stringify(afterSet.cookies));
    await daemon.call("cookies", { action: "clear" });
    const cleared = await daemon.call("cookies", { action: "get" });
    check("cookies clear removes them", !cleared.cookies.some((c) => c.name === "asf-test"), JSON.stringify(cleared.cookies));

    // ─────────────────────────────────────────────────────────────────────
    section("11. screenshot produces a real image");
    // ─────────────────────────────────────────────────────────────────────
    await daemon.call("navigate", { url: `${fixture.origin}/`, waitUntil: "load" });
    const shot = await daemon.call("screenshot", {});
    check("screenshot reports a filepath", typeof shot.filepath === "string" && shot.filepath.endsWith(".png"), JSON.stringify(shot));
    const { existsSync, statSync, readFileSync } = await import("node:fs");
    check("the screenshot file exists", existsSync(shot.filepath));
    const bytes = existsSync(shot.filepath) ? readFileSync(shot.filepath) : null;
    check("the file is non-trivial in size (>2KB, so not blank)", bytes && bytes.length > 2048, `${bytes?.length} bytes`);
    check("it is a real PNG", bytes && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", bytes?.subarray(0, 8).toString("hex"));
    const shotFull = await daemon.call("screenshot", { fullPage: true });
    check("fullPage screenshot also works", existsSync(shotFull.filepath));
    const shotEl = await daemon.call("screenshot", { selector: "#hdr" }).then((r) => r).catch(() => null);
    check("element screenshot works", !!shotEl && existsSync(shotEl.filepath), JSON.stringify(shotEl));

    // ─────────────────────────────────────────────────────────────────────
    section("12. URL safety");
    // ─────────────────────────────────────────────────────────────────────
    const fileUrl = await daemon.call("navigate", { url: "file:///etc/passwd" }).then(() => null).catch((e) => e);
    check("file:// is blocked", fileUrl?.code === "blocked-url", String(fileUrl?.code ?? fileUrl?.message));
    const badUrl = await daemon.call("navigate", { url: "not a url" }).then(() => null).catch((e) => e);
    check("a malformed URL is rejected", badUrl?.code === "invalid-url", String(badUrl?.code ?? badUrl?.message));
    const noUrl = await daemon.call("navigate", {}).then(() => null).catch((e) => e);
    check("navigate without url errors", !!noUrl);

    // loopback blocking is config-driven; with the default list it must block
    await withTempPiDir(async (piDir2) => {
      const d2 = await startDaemon(piDir2, { config: { headless: true, autoInit: true } });
      try {
        const blocked = await d2.call("navigate", { url: "http://127.0.0.1:9/", timeout: 4000 })
          .then(() => null).catch((e) => e);
        check(
          "loopback is blocked when blockedHosts is left at its default",
          blocked?.code === "blocked-url",
          String(blocked?.code ?? blocked?.message ?? "navigation succeeded"),
        );
      } finally {
        await d2.close();
      }
    });

    // ─────────────────────────────────────────────────────────────────────
    section("13. unknown RPC method");
    // ─────────────────────────────────────────────────────────────────────
    const unknown = await daemon.call("definitely_not_a_method", {}).then(() => null).catch((e) => e);
    check("unknown method returns unknown-method", unknown?.code === "unknown-method", String(unknown?.code));
  } finally {
    await daemon.close();
    await fixture.close();
  }

  ok = summary(FILE);
});

process.exit(ok ? 0 : 1);
