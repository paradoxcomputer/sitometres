// One spec, two apps: a dApp asks, the wallet approves.
//
// `open:` used to refuse every app but the spec's own, and `state:`/`eval:`
// could only reach the root of the last app opened. So a flow that starts in
// Tip Jar and finishes in the wallet could not be one spec, and the audit that
// needed one drove the "dApp" from inside the wallet's own root instead. That
// stops being a stand-in the moment the host tells a module which app is
// calling: a gate keyed on the caller sees the wallet, not a dApp.
//
// Everything here runs against an in-process inspector with two docks. It
// records the object every expression was evaluated against and every object
// clicked, which is the only evidence that settles "which app did that reach".
// Its evaluate() does what the real server does with an id it no longer
// knows: it quietly evaluates in the FIRST app's root instead of failing.
import test from "node:test";
import assert from "node:assert/strict";

import { Runner } from "../dist/runner/runner.js";
import { LogBuffer } from "../dist/logs/buffer.js";

const TIP_JAR = { name: "tip_jar", type: "ui_qml", view: "qml/Main.qml", dependencies: ["medusa_core"], main: {} };
const WALLET = { name: "medusa_ui", display_name: "Medusa", type: "ui_qml", view: "qml/Main.qml", dependencies: ["medusa_core"], main: {} };
const CORE = { name: "medusa_core", type: "core", dependencies: [], main: { "linux-amd64-dev": "medusa_core_plugin.so" } };

const APPS = [
  { manifest: TIP_JAR, slot: "plugins", artifact: "/stage/tip_jar" },
  { manifest: WALLET, slot: "plugins", artifact: "/stage/medusa_ui" },
  { manifest: CORE, slot: "modules", artifact: "/stage/medusa_core" },
];

/** A button, the way the tree serialises one. */
const button = (id, text) => ({ id, type: "Button_QMLTYPE_2", objectName: "", text, visible: true, enabled: true, children: [] });

/**
 * Basecamp with Tip Jar and the wallet installed.
 *
 * Both apps carry a button labelled "Connect", so a click that resolves in the
 * wrong dock is visible in `seen.clicks`. `answers[rootId][expr]` is what an
 * expression evaluates to in that root; anything unlisted is undefined.
 */
function basecamp({ answers = {}, logs = new LogBuffer(), launcher = null, onSidebarClick = () => {} } = {}) {
  const roots = { tip_jar: "tj-root", medusa_ui: "mu-root" };
  const seen = { clicks: [], evaluated: [], sidebar: [], probes: [] };
  const dock = (module, prefix, children) => ({
    id: `${prefix}-dock`,
    type: "QDockWidget",
    objectName: module,
    visible: true,
    children: [{
      id: `${prefix}-qw`,
      type: "QQuickWidget",
      children: [{ id: roots[module], type: "Main_QMLTYPE_9", objectName: "", visible: true, children }],
    }],
  });
  const tree = () => ({
    id: "window",
    type: "QMainWindow",
    children: [
      { id: "side-tj", type: "ItemDelegate_QMLTYPE_7", text: "tip_jar", visible: true, children: [] },
      { id: "side-mu", type: "ItemDelegate_QMLTYPE_7", text: "Medusa", visible: true, children: [] },
      dock("tip_jar", "tj", [button("tj-connect", "Connect")]),
      dock("medusa_ui", "mu", [button("mu-connect", "Connect"), button("mu-reject", "Reject")]),
    ],
  });
  const flatten = (n, out = []) => {
    out.push(n);
    for (const c of n.children ?? []) flatten(c, out);
    return out;
  };
  const find = (id) => flatten(tree()).find((n) => n.id === id);

  const inspector = {
    findAndClick: async (label) => {
      seen.sidebar.push(label);
      onSidebarClick(label, logs);
      if (!flatten(tree()).some((n) => n.text === label)) throw new Error(`No object found with text: ${label}`);
      return {};
    },
    findByType: async (typeName) => ({ matches: typeName === "SidebarPanel" && launcher ? [{ id: "sidebar" }] : [] }),
    findByProperty: async (property, value) => ({
      matches: flatten(tree()).filter((n) => n[property] === value).map((n) => ({ id: n.id })),
    }),
    getTree: async ({ objectId, depth } = {}) => {
      if (depth === 0) seen.probes.push(objectId);
      const n = objectId ? find(objectId) : tree();
      // The real server's answer for an id it no longer knows.
      if (!n) throw new Error("Root object not found");
      return { tree: depth === 0 ? { ...n, children: [] } : n };
    },
    evaluate: async (expression, objectId) => {
      if (expression.includes("launcherApps")) return { result: JSON.stringify((launcher ?? []).map((name) => ({ name }))) };
      // An unknown id is not an error on the real inspector: it falls back to
      // the first QQuickWidget's root. That is what makes a stale id dangerous.
      const where = objectId && find(objectId) ? objectId : "tj-root";
      seen.evaluated.push([expression, where]);
      if (expression.includes('"unlock"')) return { result: JSON.stringify({ ok: true }), undefined: false };
      const v = answers[where]?.[expression];
      return v === undefined ? { result: undefined, undefined: true } : { result: v, undefined: false };
    },
    clickRef: async (id) => {
      seen.clicks.push(id);
      return {};
    },
    textInventory: async () => [],
  };
  return { session: { inspector, logs }, seen, roots };
}

function runner(bc, steps, over = {}) {
  return new Runner({
    session: bc.session,
    spec: { app: "tip_jar", timeout: "5s", steps },
    appName: "tip_jar",
    manifest: TIP_JAR,
    app: APPS[0],
    apps: APPS,
    logsUsable: true,
    settleMs: 0,
    ...over,
  });
}

test("a spec opens the wallet it staged, and each app's selectors stay in that app", async () => {
  const bc = basecamp({ answers: { "mu-root": { "connectSheet.visible": true } } });
  const opened = [];
  const r = runner(bc, [
    { name: "tip jar opens", open: "tip_jar" },
    { name: "ask to connect", click: "Connect" },
    { name: "the wallet opens", open: "Medusa" },
    { name: "approve", click: "Connect", expect: { state: "connectSheet.visible" } },
    { name: "back to the dApp", open: "tip_jar" },
    { name: "click there again", click: "Connect", expect: { state: { expr: "connectSheet.visible", in: "medusa_ui" } } },
  ], { onOpened: async (m) => (opened.push(m), { failed: null }) });
  const result = await r.run();

  assert.equal(result.verdict, "pass", JSON.stringify(result.steps.map((s) => [s.name, s.error, s.checks]), null, 1));
  assert.deepEqual(bc.seen.clicks, ["tj-connect", "mu-connect", "tj-connect"], "each click resolved inside the app that was current");
  assert.deepEqual(bc.seen.sidebar, ["tip_jar", "Medusa", "tip_jar"], "the wallet was opened by its display label");

  // A string `state:` is the current app's root; `in:` reaches the other one
  // without moving the next click out of Tip Jar.
  assert.deepEqual(bc.seen.evaluated.map(([, where]) => where), ["mu-root", "mu-root"]);
  const last = result.steps[5];
  const check = last.checks.find((c) => c.kind === "state");
  assert.equal(check.description, 'state "connectSheet.visible" in medusa_ui');
  assert.equal(check.in, "medusa_ui");

  // Every step records the app it ran in, an `open:` the one it opened.
  assert.deepEqual(result.steps.map((s) => s.app), ["tip_jar", "tip_jar", "medusa_ui", "medusa_ui", "tip_jar", "tip_jar"]);
  // The hook hears every open, in order; running a profile once per app is
  // the caller's bookkeeping.
  assert.deepEqual(opened, ["tip_jar", "medusa_ui", "tip_jar"]);
  assert.equal(r.multiApp, true);
});

test("onOpened hears where the app was found, and a runner seeded with it starts inside that app (PLB-1)", async () => {
  // How `run` hands a `with:` app's profile its own dock: the profile's runner
  // has opened nothing, and unseeded it resolved "Connect" across both docks.
  const bc = basecamp({ answers: { "mu-root": { "connectSheet.visible": true } } });
  const heard = [];
  await runner(bc, [
    { name: "tip jar opens", open: "tip_jar" },
    { name: "the wallet opens", open: "medusa_ui" },
  ], { onOpened: async (m, scope) => (heard.push([m, scope]), { failed: null }) }).run();
  assert.deepEqual(heard.map(([m, s]) => [m, s.dockId, s.qmlRootId, s.view]), [
    ["tip_jar", "tj-dock", "tj-root", "qml/Main.qml"],
    ["medusa_ui", "mu-dock", "mu-root", "qml/Main.qml"],
  ]);

  const profileSteps = [{ name: "approve", click: "Connect", expect: { state: "connectSheet.visible" } }];
  const seeded = await new Runner({
    session: bc.session,
    spec: { app: "medusa_ui", timeout: "5s", steps: profileSteps },
    appName: "medusa_ui",
    manifest: WALLET,
    app: APPS[1],
    logsUsable: true,
    settleMs: 0,
    initialScope: { module: "medusa_ui", scope: heard[1][1] },
  }).run();
  assert.equal(seeded.verdict, "pass", JSON.stringify(seeded.steps.map((s) => [s.error, s.checks])));
  assert.deepEqual(bc.seen.clicks, ["mu-connect"], "the wallet's Connect, not Tip Jar's");
  assert.deepEqual(bc.seen.evaluated.map(([, where]) => where), ["mu-root"]);
  assert.equal(seeded.steps[0].app, "medusa_ui");

  // The same steps with nothing opened: both docks are in reach, so the label is ambiguous.
  const unseeded = await new Runner({
    session: bc.session,
    spec: { app: "medusa_ui", timeout: "5s", steps: profileSteps },
    appName: "medusa_ui",
    manifest: WALLET,
    app: APPS[1],
    logsUsable: true,
    settleMs: 0,
  }).run();
  assert.equal(unseeded.verdict, "fail");
  assert.match(unseeded.steps[0].error, /ambiguous/);
});

test("`in:` before the app is opened is INCONCLUSIVE, and says to open it", async () => {
  const bc = basecamp();
  const result = await runner(bc, [
    { name: "tip jar opens", open: "tip_jar" },
    { name: "peek at the wallet", expect: { state: { expr: "connectSheet.visible", in: "medusa_ui" } } },
  ]).run();
  const check = result.steps[1].checks.find((c) => c.kind === "state");
  assert.equal(check.verdict, "inconclusive");
  assert.match(check.detail, /medusa_ui has not been opened/);
  assert.match(check.detail, /open: medusa_ui/);
  assert.equal(bc.seen.evaluated.length, 0, "nothing was evaluated anywhere, the first app's root least of all");
});

test("`in:` naming an app that was not staged fails, listing the ones that were", async () => {
  const bc = basecamp();
  const result = await runner(bc, [
    { name: "tip jar opens", open: "tip_jar" },
    { name: "a typo", expect: { state: { expr: "x", in: "not_staged" } } },
    { name: "an eval there", eval: { expr: "1", in: "not_staged" } },
  ]).run();
  const check = result.steps[1].checks.find((c) => c.kind === "state");
  assert.equal(check.verdict, "fail");
  for (const re of [/tip_jar/, /medusa_ui \("Medusa"\)/]) assert.match(check.detail, re);
  assert.doesNotMatch(check.detail, /medusa_core/, "a core module is not something `in:` can name");
  assert.equal(result.steps[2].verdict, "fail");
  assert.match(result.steps[2].error, /not a UI app this run staged/);
  assert.match(result.steps[2].error, /medusa_ui \("Medusa"\)/);
});

test("an `eval:` in an app not yet opened fails, telling you to open it first", async () => {
  const bc = basecamp();
  const result = await runner(bc, [
    { name: "tip jar opens", open: "tip_jar" },
    { name: "poke the wallet", eval: { expr: "root.x = 1", in: "medusa_ui" } },
  ]).run();
  assert.equal(result.steps[1].verdict, "fail");
  assert.match(result.steps[1].error, /cannot evaluate "root\.x = 1" in medusa_ui/);
  assert.match(result.steps[1].error, /open: medusa_ui/);
});

test("an `eval:` with `in:` runs in that app's root and says so", async () => {
  const bc = basecamp({ answers: { "mu-root": { "root.walletState": "ready" } } });
  const result = await runner(bc, [
    { open: "medusa_ui" },
    { open: "tip_jar" },
    { eval: { expr: "root.walletState", in: "Medusa" } },
  ]).run();
  assert.equal(result.verdict, "pass", JSON.stringify(result.steps));
  assert.deepEqual(bc.seen.evaluated.at(-1), ["root.walletState", "mu-root"]);
  assert.match(result.steps[2].action, /-> "ready" in medusa_ui$/);
  assert.equal(result.steps[2].app, "tip_jar", "evaluating elsewhere does not move the step's app");
});

test("a stale root is found again, instead of evaluating in whichever app comes first", async () => {
  const bc = basecamp({ answers: { "mu-root-2": { "root.reloaded": true } } });
  let reload = null;
  const r = runner(bc, [
    { open: "medusa_ui" },
    { open: "tip_jar" },
    { name: "the wallet reloads", eval: "1" },
    { name: "read it", expect: { state: { expr: "root.reloaded", in: "medusa_ui" } } },
  ], {
    onStep: (s) => {
      if (s.index === 2) reload();
    },
  });
  reload = () => (bc.roots.medusa_ui = "mu-root-2");
  const result = await r.run();
  const check = result.steps[3].checks.find((c) => c.kind === "state");
  assert.equal(check.verdict, "pass", JSON.stringify(check));
  assert.deepEqual(bc.seen.evaluated.at(-1), ["root.reloaded", "mu-root-2"], "the new root, not Tip Jar's");
  assert.ok(bc.seen.probes.includes("mu-root"), "the cached id was checked before it was trusted");
});

test("a single-app spec is not multi-app, even when it names its own app with `in:`", () => {
  const bc = basecamp();
  assert.equal(runner(bc, [{ open: "tip_jar" }, { expect: { state: { expr: "x", in: "tip_jar" } } }]).multiApp, false);
  assert.equal(runner(bc, [{ open: "tip_jar" }, { expect: { state: { expr: "x", in: "Medusa" } } }]).multiApp, true);
  assert.equal(runner(bc, [{ open: "tip_jar" }, { open: "medusa_ui" }]).multiApp, true);
});

test("errors from every opened app count, and each names the app it came from", async () => {
  const bc = basecamp();
  const logs = bc.session.logs;
  const r = runner(bc, [
    { open: "tip_jar" },
    { open: "medusa_ui" },
    { open: "tip_jar" },
    { name: "click in the dApp", click: "Connect", expect: { noErrors: true } },
  ]);
  // Delivered during step 4's window: the click in the dApp is posted, then
  // the wallet's QML throws.
  const realClick = bc.session.inspector.clickRef;
  bc.session.inspector.clickRef = async (id) => {
    logs.append("file:///u/plugins/medusa_ui/qml/Main.qml:9: TypeError: boom", "stderr");
    return realClick(id);
  };
  const result = await r.run();
  const noErrors = result.steps[3].checks.find((c) => c.kind === "noErrors");
  assert.equal(noErrors.verdict, "fail");
  assert.equal(noErrors.description, "no new QML errors in tip_jar, medusa_ui");
  assert.match(noErrors.detail, /^medusa_ui: /, "the failure names the app that threw");
});

test("the wallet is unlocked only through the spec app's own root", async () => {
  const bc = basecamp();
  const provider = { module: "medusa_core", name: "Medusa", needsPassword: true, storePath: "/x", hasStore: false };
  const result = await runner(bc, [{ open: "medusa_ui" }, { open: "tip_jar" }, { open: "medusa_ui" }], {
    walletUnlock: { provider, password: "pw-not-for-the-wallet-root" },
  }).run();
  assert.equal(result.verdict, "pass", JSON.stringify(result.steps));
  const unlocks = bc.seen.evaluated.filter(([expr]) => expr.includes('"unlock"'));
  assert.deepEqual(unlocks.map(([, where]) => where), ["tj-root"], "once, when the spec app opened, and never through the wallet's root");
});

test("a failed open is diagnosed from the log of the app being opened", async (t) => {
  // Frozen clock, as openapp.test.mjs does: every inspector call is charged
  // three seconds, so the click window and the launcher's verdict arrive in a
  // handful of real milliseconds.
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => (now += 3000);
  t.after(() => (Date.now = realNow));

  const bc = basecamp({
    launcher: ["tip_jar"],
    onSidebarClick: (label, logs) => {
      if (label === "Medusa" || label === "medusa_ui") {
        logs.append(
          'Failed to compile ui_qml view "medusa_ui" : "file:///u/plugins/medusa_ui/qml/Main.qml:217:98: Unexpected token `;\'\\n"',
          "stderr",
        );
      }
    },
  });
  // The wallet's sidebar entry never renders, so the click cannot land.
  const click = bc.session.inspector.findAndClick;
  bc.session.inspector.findAndClick = async (label) => {
    if (label === "Medusa" || label === "medusa_ui") {
      await click(label).catch(() => {});
      throw new Error(`No object found with text: ${label}`);
    }
    return click(label);
  };
  const result = await runner(bc, [{ open: "tip_jar" }, { open: "medusa_ui" }]).run();
  assert.equal(result.steps[1].verdict, "fail");
  assert.match(result.steps[1].error, /medusa_ui's QML did not compile/, result.steps[1].error);
  assert.equal(result.steps[1].app, "tip_jar", "the failed open ran while Tip Jar was current");
});
