// `run` for a spec that drives two apps: whose profile runs when, what the
// header says was staged, and where a wallet password may go.
//
// The runner only reports what it opened. Which profile belongs to which app,
// and running each once, is `run`'s bookkeeping, and it used to be one flag:
// the setup profile ran after the first `open:` of ANY app. A dApp spec that
// opened the wallet first would have typed the dApp's gate into the wallet.
//
// `run` is called with a stub boot and an in-process session, so the whole
// command runs without a Basecamp. The inspector records every sidebar click
// and every control clicked, in one ordered list, which is what "the profile
// ran after that open, and only once" is checked against.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { run } from "../dist/commands/run.js";
import { smoke } from "../dist/commands/smoke.js";
import { boot } from "../dist/session.js";
import { LogBuffer } from "../dist/logs/buffer.js";
import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("./helpers/fake-basecamp.mjs", import.meta.url));
const PASSWORD = "hunter2-cross-app-secret";

const made = [];
const tmp = (p) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  made.push(d);
  return d;
};
test.after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const DAPP = { name: "demo_dapp", version: "0.2.1", type: "ui_qml", view: "qml/Main.qml", dependencies: ["demo_core"], main: {} };
const WALLET = { name: "demo_wallet", display_name: "Wallet", version: "0.5.0", type: "ui_qml", view: "qml/Main.qml", dependencies: ["demo_core"], main: {} };
const CORE = { name: "demo_core", version: "0.5.0", type: "core", dependencies: [], main: { "linux-amd64-dev": "demo_core_plugin.so" } };

const discovered = (manifest, slot, artifact) => ({
  manifest, slot, artifact, form: "dir", built: true, origin: artifact, label: manifest.display_name ?? manifest.name,
  builtAt: Date.now(), provenance: "local",
});

const hex = (c) => c.repeat(64);
const RECORDS = [
  { name: "demo_dapp", version: "0.2.1", slot: "plugins", artifact: "/w/dapp/plugins/demo_dapp", form: "dir", provenance: "local", builtAt: Date.now() - 120_000, hashes: [{ kind: "view", path: "qml/Main.qml", sha256: hex("a") }] },
  { name: "demo_wallet", version: "0.5.0", slot: "plugins", artifact: "/w/wallet/plugins/demo_wallet", form: "dir", provenance: "installed", builtAt: null, hashes: [{ kind: "view", path: "qml/Main.qml", sha256: hex("b") }] },
  { name: "demo_core", version: "0.5.0", slot: "modules", artifact: "/w/wallet/result/demo_core.lgx", form: "lgx", provenance: "local", builtAt: null, hashes: [{ kind: "library", path: "demo_core_plugin.so", sha256: hex("c") }] },
];

/** Two docks, each holding its app's root, and a gate button a profile clicks. */
function session() {
  const events = [];
  // Every tree read, evaluation and click, in order: where each one landed.
  const trace = [];
  const button = (id, text) => ({ id, type: "Button_QMLTYPE_2", objectName: "", text, visible: true, enabled: true, children: [] });
  const dock = (module, prefix, children) => ({
    id: `${prefix}-dock`, type: "QDockWidget", objectName: module, visible: true,
    children: [{ id: `${prefix}-qw`, type: "QQuickWidget", children: [{ id: `${prefix}-root`, type: "Main_QMLTYPE_3", visible: true, children }] }],
  });
  const tree = {
    id: "window", type: "QMainWindow",
    children: [
      { id: "side-dapp", type: "ItemDelegate_QMLTYPE_7", text: "demo_dapp", visible: true, children: [] },
      { id: "side-wallet", type: "ItemDelegate_QMLTYPE_7", text: "Wallet", visible: true, children: [] },
      dock("demo_dapp", "dapp", [button("dapp-gate", "Dapp Gate"), button("custom-gate", "Custom Gate")]),
      dock("demo_wallet", "wallet", [button("wallet-gate", "Wallet Gate")]),
    ],
  };
  const all = [];
  (function walk(n) {
    all.push(n);
    for (const c of n.children ?? []) walk(c);
  })(tree);
  const find = (id) => all.find((n) => n.id === id);
  const inspector = {
    findAndClick: async (label) => {
      if (!all.some((n) => n.text === label)) throw new Error(`No object found with text: ${label}`);
      events.push(`open ${label}`);
      return {};
    },
    findByType: async () => ({ matches: [] }),
    findByProperty: async (p, v) => ({ matches: all.filter((n) => n[p] === v).map((n) => ({ id: n.id })) }),
    getTree: async ({ objectId } = {}) => {
      trace.push(`tree ${objectId ?? "window"}`);
      const n = objectId ? find(objectId) : tree;
      if (!n) throw new Error("Root object not found");
      return { tree: n };
    },
    evaluate: async (expression, objectId) => {
      if (expression.includes('"unlock"')) {
        events.push(`unlock via ${objectId}`);
        return { result: JSON.stringify({ ok: true }), undefined: false };
      }
      trace.push(`eval ${objectId}`);
      return { result: true, undefined: false };
    },
    clickRef: async (id) => {
      events.push(`click ${id}`);
      trace.push(`click ${id}`);
      return {};
    },
    textInventory: async () => [],
    screenshot: async () => ({ image: "" }),
  };
  return {
    events,
    trace,
    session: {
      inspector,
      logs: new LogBuffer(),
      logSource: { describe: () => "in-process" },
      port: 41299,
      mode: "owned",
    },
  };
}

/** A stub boot handing `run` two staged UI apps, their core and their records. */
function deps(s, over = {}) {
  const app = discovered(DAPP, "plugins", "/w/dapp/plugins/demo_dapp");
  const staged = [app, discovered(WALLET, "plugins", "/w/wallet/plugins/demo_wallet"), discovered(CORE, "modules", "/w/wallet/result/demo_core.lgx")];
  return {
    boot: async () => ({
      session: s.session,
      ready: { portMs: 1, uiProbeMs: 1, modulesLoaded: [] },
      fidelity: { fidelity: "verbose", qtLogLines: 10, moduleLogLines: 0, summary: "Qt logging is on", remedy: "" },
      app,
      staged,
      plan: null,
      stagedRecords: RECORDS,
      sandboxHome: "/tmp/sitometres-home-x",
      appHome: "/tmp/sitometres-home-x",
      walletSummary: null,
      walletUnlock: null,
      basecamp: { path: "/opt/LogosBasecamp", origin: "test", inspectorEnabled: true },
      userDir: { root: "/tmp/sitometres-x", foreign: [], replaced: [], restores: false, inPlace: [] },
      dispose: async () => {},
      ...over,
    }),
  };
}

/** A working directory with a spec and whichever profiles a test wants. */
function workdir(steps, profiles = {}) {
  const cwd = tmp("sito-xrun-");
  const spec = path.join(cwd, "spec.yaml");
  fs.writeFileSync(spec, ["app: demo_dapp", "with: [demo_wallet, demo_core]", "timeout: 5s", "steps:", ...steps.map((s) => `  - ${s}`), ""].join("\n"));
  for (const [rel, gate] of Object.entries(profiles)) {
    const file = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ["steps:", `  - name: walk the ${gate}`, `    click: "${gate}"`, ""].join("\n"));
  }
  return { cwd, spec };
}

async function quiet(fn) {
  const log = console.log;
  const err = console.error;
  const out = [];
  console.log = (...a) => out.push(a.join(" "));
  console.error = (...a) => out.push(a.join(" "));
  try {
    return { code: await fn(), out: out.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

test("each app's profile runs once, after that app's first open, whichever app opens first", async () => {
  const s = session();
  const { cwd, spec } = workdir(
    ["open: demo_wallet", "open: demo_dapp", "open: Wallet", "open: demo_dapp"],
    { ".sitometres/setup.yaml": "Dapp Gate", ".sitometres/demo_wallet.setup.yaml": "Wallet Gate" },
  );
  const json = path.join(cwd, "out.json");
  const { code, out } = await quiet(() => run({ specPath: spec, cwd, json }, deps(s)));
  assert.equal(code, 0, out);
  assert.deepEqual(s.events, [
    "open Wallet",
    "click wallet-gate",
    "open demo_dapp",
    "click dapp-gate",
    "open Wallet",
    "open demo_dapp",
  ]);
  // The header names both apps and their core, with their hashes.
  const block = out.split("\n").filter((l) => /^ {2}staged {4}| {12}\S/.test(l));
  assert.match(block[0], /^ {2}staged {4}demo_dapp 0\.2\.1 +local +.*\(dir, 2 min ago\) +view +a{16}$/);
  assert.match(block[1], /^ {12}demo_wallet 0\.5\.0 +installed +.*\(dir, build time unknown\) +view +b{16}$/);
  assert.match(block[2], /^ {12}demo_core 0\.5\.0 +local +.*\(lgx, build time unknown\) +library c{16}$/);
  // A two-app spec prints the app under each step, and the JSON says it too.
  assert.match(out, /\n {8}in demo_wallet\n/);
  const report = JSON.parse(fs.readFileSync(json, "utf8"));
  assert.deepEqual(report.steps.map((x) => x.app), ["demo_wallet", "demo_dapp", "demo_wallet", "demo_dapp"]);
  assert.equal(report.multiApp, true);
  assert.equal(report.staged.length, 3);
  assert.equal(report.staged[2].hashes[0].sha256, hex("c"));
});

test("--setup is the spec app's alone, and --no-setup runs no profile at all", async () => {
  const profiles = { ".sitometres/setup.yaml": "Dapp Gate", ".sitometres/demo_wallet.setup.yaml": "Wallet Gate", "custom.yaml": "Custom Gate" };
  const steps = ["open: demo_dapp", "open: demo_wallet"];

  const s1 = session();
  const w1 = workdir(steps, profiles);
  const one = await quiet(() => run({ specPath: w1.spec, cwd: w1.cwd, setup: path.join(w1.cwd, "custom.yaml") }, deps(s1)));
  assert.equal(one.code, 0, one.out);
  assert.deepEqual(s1.events, ["open demo_dapp", "click custom-gate", "open Wallet", "click wallet-gate"],
    "the explicit profile replaced the dApp's, and the wallet still got its own");

  const s2 = session();
  const w2 = workdir(steps, profiles);
  const two = await quiet(() => run({ specPath: w2.spec, cwd: w2.cwd, noSetup: true }, deps(s2)));
  assert.equal(two.code, 0, two.out);
  assert.deepEqual(s2.events, ["open demo_dapp", "open Wallet"]);
});

test("an unnamed profile never lands on a `with:` app", async () => {
  const s = session();
  const { cwd, spec } = workdir(["open: demo_wallet", "open: demo_dapp"], { ".sitometres/setup.yaml": "Dapp Gate" });
  const { code, out } = await quiet(() => run({ specPath: spec, cwd }, deps(s)));
  assert.equal(code, 0, out);
  assert.deepEqual(s.events, ["open Wallet", "open demo_dapp", "click dapp-gate"]);
  assert.match(out, /setup none found for demo_wallet/);
});

/**
 * A profile that addresses its control by position and checks a property, the
 * way profiles/medusa_ui.yaml types into `{ type: "Pre64TextInput", nth: 0 }`.
 */
function positionalProfile(cwd, rel, expr) {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    "steps:",
    "  - name: the first button",
    '    click: { type: "Button", nth: 0 }',
    "    expect:",
    `      state: "${expr}"`,
    "",
  ].join("\n"));
}

/** What the trace recorded from `from` on: the first click, and every evaluation. */
function landed(trace, from) {
  const tail = trace.slice(from);
  const at = tail.findIndex((e) => e.startsWith("click "));
  const reads = tail.slice(0, at).filter((e) => e.startsWith("tree "));
  return {
    click: tail[at],
    readBeforeClick: reads[reads.length - 1],
    evals: tail.filter((e) => e.startsWith("eval ")),
  };
}

test("a `with:` app's profile acts in its own dock once the dApp's dock is open too (PLB-1)", async () => {
  // The dApp's dock holds Buttons ahead of the wallet's in the tree. A profile
  // runner that had opened nothing read the whole window, so `nth: 0` was the
  // dApp's button, and its `state:` had no root at all (INCONCLUSIVE).
  const s = session();
  const { cwd, spec } = workdir(["open: demo_dapp", "open: demo_wallet"]);
  positionalProfile(cwd, ".sitometres/demo_wallet.setup.yaml", "walletReady");
  const { code, out } = await quiet(() => run({ specPath: spec, cwd }, deps(s)));
  assert.equal(code, 0, out);
  assert.deepEqual(s.events, ["open demo_dapp", "open Wallet", "click wallet-gate"], "the wallet's button, not the dApp's");
  const seen = landed(s.trace, s.trace.lastIndexOf("tree wallet-dock"));
  assert.equal(seen.click, "click wallet-gate");
  assert.equal(seen.readBeforeClick, "tree wallet-root", "the selector read the wallet's own root");
  assert.ok(seen.evals.length > 0, "the profile's state was evaluated, not left without a root");
  assert.ok(seen.evals.every((e) => e === "eval wallet-root"), JSON.stringify(seen.evals));
});

test("the spec app's profile is scoped too when a `with:` app opened first (PLB-1)", async () => {
  const s = session();
  const { cwd, spec } = workdir(["open: demo_wallet", "open: demo_dapp"]);
  positionalProfile(cwd, ".sitometres/setup.yaml", "dappReady");
  const { code, out } = await quiet(() => run({ specPath: spec, cwd }, deps(s)));
  assert.equal(code, 0, out);
  assert.deepEqual(s.events, ["open Wallet", "open demo_dapp", "click dapp-gate"]);
  const seen = landed(s.trace, s.trace.lastIndexOf("tree dapp-dock"));
  assert.equal(seen.readBeforeClick, "tree dapp-root");
  assert.ok(seen.evals.length > 0 && seen.evals.every((e) => e === "eval dapp-root"), JSON.stringify(seen.evals));
});

test("with one dock open, a profile that reads state first opens its own app, so the state is really read", async () => {
  // A `state:` with no root used to read INCONCLUSIVE, which a profile counted as done: a
  // profile "passed" a gate it never evaluated (found live on medusa_ui, whose profile then left
  // every spec on the create screen). A profile that reads state now opens its app first, so
  // the expression is evaluated in that app's root, and the gate click still lands once.
  const s = session();
  const { cwd, spec } = workdir(["open: demo_dapp"]);
  positionalProfile(cwd, ".sitometres/setup.yaml", "dappReady");
  const { code, out } = await quiet(() => run({ specPath: spec, cwd }, deps(s)));
  assert.equal(code, 0, out);
  assert.equal(s.events.filter((e) => e === "click dapp-gate").length, 1, JSON.stringify(s.events));
  assert.equal(s.events[0], "open demo_dapp", JSON.stringify(s.events));
  const seen = landed(s.trace, s.trace.indexOf("tree dapp-dock"));
  assert.ok(seen.evals.length > 0 && seen.evals.every((e) => e === "eval dapp-root"), JSON.stringify(seen.evals));
});

test("a wallet password is used only through the spec app, and reaches no output", async () => {
  const s = session();
  const { cwd, spec } = workdir(["open: demo_wallet", "open: demo_dapp", "open: demo_wallet"]);
  const json = path.join(cwd, "out.json");
  const junit = path.join(cwd, "out.xml");
  const provider = { module: "demo_core", name: "Demo", needsPassword: true, storePath: "/x", hasStore: false };
  const prev = process.env.SITOMETRES_WALLET_PASSWORD;
  process.env.SITOMETRES_WALLET_PASSWORD = PASSWORD;
  try {
    const { code, out } = await quiet(() =>
      run({ specPath: spec, cwd, json, junit, noSetup: true }, deps(s, { walletUnlock: { provider, password: PASSWORD } })),
    );
    assert.equal(code, 0, out);
    assert.deepEqual(s.events.filter((e) => e.startsWith("unlock")), ["unlock via dapp-root"], "once, through the dApp's own root");
    assert.ok(!out.includes(PASSWORD), "not on stdout");
    assert.ok(!fs.readFileSync(json, "utf8").includes(PASSWORD), "not in --json");
    assert.ok(!fs.readFileSync(junit, "utf8").includes(PASSWORD), "not in --junit");
  } finally {
    if (prev === undefined) delete process.env.SITOMETRES_WALLET_PASSWORD;
    else process.env.SITOMETRES_WALLET_PASSWORD = prev;
  }
});

test("smoke header: the crawl prints the same staged block, and its artifact carries it", async () => {
  // Through the real boot and the fake Basecamp, so the records are the ones
  // boot hashed from a real staged user-dir.
  const root = tmp("sito-xrun-smoke-");
  const dir = path.join(root, "plugins", "demo_ui");
  fs.mkdirSync(path.join(dir, "qml"), { recursive: true });
  fs.writeFileSync(path.join(dir, "qml", "Main.qml"), "import QtQuick\nItem {}\n");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name: "demo_ui", version: "3.1.4", type: "ui_qml", view: "qml/Main.qml", dependencies: [], main: {} }));
  const json = path.join(root, "crawl.json");
  let booted;
  const { out } = await quiet(() =>
    smoke({ cwd: root, json, noSetup: true, noReport: true }, {
      boot: async (opts) => (booted = await boot({ ...opts, basecamp: FAKE, timeoutMs: 15_000 })),
    }),
  );
  const line = out.split("\n").find((l) => l.startsWith("  staged    "));
  assert.ok(line, out);
  const record = booted.stagedRecords[0];
  assert.match(line, /^ {2}staged {4}demo_ui 3\.1\.4 +local +/);
  assert.ok(line.endsWith(`view    ${record.hashes[0].sha256.slice(0, 16)}`), line);
  const report = JSON.parse(fs.readFileSync(json, "utf8"));
  assert.deepEqual(report.staged, booted.stagedRecords);
});
