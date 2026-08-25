// Regressions found by auditing the suite for what it did NOT cover.
// Every test here failed before its fix; several were silent-pass bugs, which
// is the worst failure mode a test runner can have.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { validateSpec } from "../dist/spec/schema.js";
import { UiSnapshot } from "../dist/runner/snapshot.js";
import { resolveAll, resolveOne } from "../dist/runner/selector.js";
import { classifyOutcome } from "../dist/runner/outcome.js";
import { LogBuffer } from "../dist/logs/buffer.js";
import { parseLine } from "../dist/logs/classify.js";
import { discoverApps } from "../dist/app/discover.js";
import { unpackLgx } from "../dist/app/userdir.js";
import { labelShape, collapseRows, BACK, DESTRUCTIVE } from "../dist/commands/smoke.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const win = (lines) => {
  const b = new LogBuffer();
  for (const l of lines) b.append(l, "stdout");
  return b.slice(0).map(parseLine);
};

// --- spec: a selector that constrains nothing must not match everything -----

test("snake_case inside a LIST is normalised, not left raw", () => {
  // Left raw, every field of the selector was undefined — and a selector with
  // no constraints matched every node, so the assertion passed regardless of
  // what the app rendered.
  const spec = validateSpec({
    steps: [{ click: "Go", expect: { text: [{ object_name: "amountField", include_hidden: true }] } }],
  });
  assert.deepEqual(spec.steps[0].expect.text[0], { objectName: "amountField", includeHidden: true });
});

test("an empty selector matches nothing", async () => {
  const snap = await UiSnapshot.capture({
    getTree: async () => ({
      tree: { id: "1", type: "QQuickItem", visible: true, children: [{ id: "2", type: "QQuickText", visible: true, text: "hi" }] },
    }),
  });
  assert.equal(resolveAll(snap, {}).length, 0, "a selector constraining nothing must match nothing");
});

test("a mistyped step key is rejected instead of ignored", () => {
  // `clik:` validated cleanly and then did nothing, which reads as a passing
  // test of a control that was never touched.
  assert.throws(() => validateSpec({ steps: [{ clik: "Go" }] }), /unknown key `clik`/);
  assert.throws(() => validateSpec({ steps: [{ click: "Go", expct: {} }] }), /unknown key `expct`/);
});

// --- snapshot: a caption is not a button ------------------------------------

test("prose does not resolve to an unrelated button elsewhere in the app", async () => {
  // The app-root guard broke AFTER pushing the root into the chain, so the
  // hit-area scan searched the whole app and returned the first MouseArea in it.
  const tree = {
    id: "1", type: "QWidget", visible: true, enabled: true, children: [
      { id: "2", type: "QQuickWidget", visible: true, enabled: true, children: [
        { id: "40", type: "QQuickText", visible: true, text: "Pick a chain, then tap Connect." },
        { id: "10", type: "QQuickRectangle", visible: true, enabled: true, children: [
          { id: "11", type: "QQuickText", visible: true, text: "Create wallet" },
          { id: "12", type: "QQuickMouseArea", visible: true, enabled: true },
        ] },
      ] },
    ],
  };
  const snap = await UiSnapshot.capture({ getTree: async () => ({ tree }) });
  const prose = snap.nodes.find((n) => n.id === "40");
  assert.equal(snap.clickTargetFor(prose).via, "fallback", "a caption has no control of its own");
  assert.throws(() => resolveOne(snap, { text: "Pick a chain, then tap Connect.", clickable: true }));
  // The real sibling idiom must still work.
  assert.equal(resolveOne(snap, { text: "Create wallet", clickable: true }).target.id, "12");
});

// --- outcome: background polling is not a click's failure -------------------

test("a poll timeout that predates the step is not blamed on the click", () => {
  // pairFailures only knows the module from a call_started inside the same
  // window, so a poll begun before the cursor pairs as "?.pendingRequests" —
  // which no fully-qualified ignore entry could match.
  const r = classifyOutcome({
    window: win([
      '[LogosObject] RemoteLogosObject::callMethod "pendingRequests" args: 0',
      "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
    ]),
    newLabels: [],
    appName: "medusa_ui",
    ignoreCalls: ["medusa_core.pendingRequests", "medusa_core.getJob"],
    logsUsable: true,
  });
  assert.deepEqual(r.failedCalls, []);
  assert.equal(r.outcome, "nothing");
});

test("a real failure is still reported", () => {
  const r = classifyOutcome({
    window: win([
      'LogosAPIClient: invoking remote method "medusa_core" "sendTransfer" args_count: 2',
      '[LogosObject] RemoteLogosObject::callMethod "sendTransfer" args: 2',
      "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
    ]),
    newLabels: [],
    appName: "medusa_ui",
    ignoreCalls: ["medusa_core.pendingRequests"],
    logsUsable: true,
  });
  assert.equal(r.outcome, "failed");
  assert.match(r.failedCalls.join(), /sendTransfer/);
});

test("the outcome ladder grades each case distinctly", () => {
  const base = { appName: "app", ignoreCalls: [], logsUsable: true };
  const call = ['LogosAPIClient: invoking remote method "m" "go" args_count: 0'];
  assert.equal(classifyOutcome({ ...base, window: win([]), newLabels: [] }).outcome, "nothing");
  assert.equal(classifyOutcome({ ...base, window: win([]), newLabels: ["something new"] }).outcome, "unclear");
  assert.equal(classifyOutcome({ ...base, window: win(call), newLabels: [] }).outcome, "ran");
  assert.equal(classifyOutcome({ ...base, window: win(call), newLabels: ["Sent"] }).outcome, "worked");
  assert.equal(classifyOutcome({ ...base, window: win(call), newLabels: ["Transfer failed"] }).outcome, "failed");
  // A quiet build cannot tell "no call" from "call not logged".
  assert.equal(
    classifyOutcome({ ...base, logsUsable: false, window: win([]), newLabels: [] }).outcome,
    "unclear",
  );
});

test("bare and wildcard ignore forms work for failures as well as calls", () => {
  const w = win([
    '[LogosObject] RemoteLogosObject::callMethod "pendingRequests" args: 0',
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
  ]);
  for (const form of ["pendingRequests", "medusa_core.pendingRequests", "?.pendingRequests"]) {
    const r = classifyOutcome({ window: w, newLabels: [], appName: "a", ignoreCalls: [form], logsUsable: true });
    assert.deepEqual(r.failedCalls, [], `ignore form ${JSON.stringify(form)} should suppress it`);
  }
  // A wildcard over a MODULE cannot suppress a failure whose module is unknown:
  // the pairing never saw a call_started for it, so claiming it belongs to
  // medusa_core would be a guess. It stays reported.
  const wild = classifyOutcome({ window: w, newLabels: [], appName: "a", ignoreCalls: ["medusa_core.*"], logsUsable: true });
  assert.deepEqual(wild.failedCalls, ["?.pendingRequests"]);
});

// --- discover: a package must contain what it promises ----------------------

function lgx(entries) {
  const chunks = [];
  for (const [name, content] of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write("000644 ", 100);
    h.write("0000000 ", 108);
    h.write("0000000 ", 116);
    h.write(Buffer.byteLength(content).toString(8).padStart(11, "0") + " ", 124);
    h.write("00000000000 ", 136);
    h.write("        ", 148);
    h.write("0", 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512 || 512);
    body.write(content);
    chunks.push(h, body);
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

test("a manifest-only .lgx is incomplete and loses to a real directory", () => {
  const root = tmp("sito-lgxc-");
  const manifest = JSON.stringify({ name: "app1", type: "ui_qml", main: {}, view: "qml/Main.qml", version: "0.1.0" });

  fs.mkdirSync(path.join(root, "result"), { recursive: true });
  fs.writeFileSync(path.join(root, "result", "app1.lgx"), lgx([["manifest.json", manifest]]));
  const dir = path.join(root, "plugins", "app1");
  fs.mkdirSync(path.join(dir, "qml"), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), manifest);
  fs.writeFileSync(path.join(dir, "qml", "Main.qml"), "x");

  // The .lgx branch skipped the completeness check entirely, so a bundle with
  // nothing in it outranked a fully built directory.
  const picked = discoverApps(root).find((a) => a.manifest.name === "app1");
  assert.equal(picked.form, "dir", "the real directory must win");

  const alone = tmp("sito-lgxa-");
  fs.mkdirSync(path.join(alone, "result"), { recursive: true });
  fs.writeFileSync(path.join(alone, "result", "app1.lgx"), lgx([["manifest.json", manifest]]));
  const only = discoverApps(alone).find((a) => a.manifest.name === "app1");
  assert.match(only.incomplete ?? "", /view "qml\/Main\.qml"/);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(alone, { recursive: true, force: true });
});

test("a complete .lgx is still accepted", () => {
  const root = tmp("sito-lgxok-");
  fs.mkdirSync(path.join(root, "result"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "result", "app2.lgx"),
    lgx([
      ["manifest.json", JSON.stringify({ name: "app2", type: "ui_qml", main: {}, view: "qml/Main.qml" })],
      ["variants/linux-amd64-dev/qml/Main.qml", "import QtQuick"],
    ]),
  );
  const found = discoverApps(root).find((a) => a.manifest.name === "app2");
  assert.equal(found.incomplete, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test("unpackLgx cannot write outside its destination", () => {
  const root = tmp("sito-trav-");
  const dest = path.join(root, "a", "b", "dest");
  fs.mkdirSync(dest, { recursive: true });
  const file = path.join(root, "evil.lgx");
  fs.writeFileSync(
    file,
    lgx([
      ["manifest.json", JSON.stringify({ name: "evil", type: "core", main: {} })],
      ["variants/linux-amd64-dev/../../../escape.txt", "pwned"],
      ["variants/linux-amd64-dev/ok.txt", "fine"],
    ]),
  );
  unpackLgx(file, dest, "linux-amd64-dev");
  assert.ok(!fs.existsSync(path.join(root, "a", "escape.txt")), "a tar entry must not escape the destination");
  assert.ok(!fs.existsSync(path.join(root, "escape.txt")));
  assert.ok(fs.existsSync(path.join(dest, "ok.txt")), "legitimate entries must still unpack");
  fs.rmSync(root, { recursive: true, force: true });
});

// --- smoke internals ---------------------------------------------------------

test("labelShape folds data but keeps distinct names apart", () => {
  assert.equal(labelShape("01010101…0101"), labelShape("77777777…7777"));
  assert.notEqual(labelShape("Send"), labelShape("Cancel"));
  assert.ok(labelShape("01010101…0101").includes("#"), "a data row must be marked foldable");
  assert.ok(!labelShape("Connect with Medusa").includes("#"), "a plain name must not be");
});

test("collapseRows samples a list and leaves named controls alone", () => {
  const rows = ["01010101…0101", "77777777…7777", "88888888…8888", "82010101…0101"].map((label) => ({
    label,
    type: "TxRow",
  }));
  const named = ["Send", "Cancel", "Refresh"].map((label) => ({ label, type: "Button" }));
  const { kept, collapsed } = collapseRows([...rows, ...named]);
  assert.equal(collapsed, rows.length - 2, "two of the shape are kept");
  assert.equal(kept.filter((k) => k.type === "Button").length, 3, "named controls are never folded");
});

test("navigation and destructive labels are recognised", () => {
  for (const b of ["←", "Back", "Close", "✕", "done"]) assert.ok(BACK.test(b), `${b} should be back-ish`);
  for (const b of ["Send a tip", "Export mnemonic", "Reset wallet", "Approve"]) {
    assert.ok(DESTRUCTIVE.test(b), `${b} should be skipped by the crawler`);
  }
  for (const ok of ["Connect with Medusa", "Refresh", "Latest Transactions"]) {
    assert.ok(!DESTRUCTIVE.test(ok), `${ok} should be clickable`);
  }
});
