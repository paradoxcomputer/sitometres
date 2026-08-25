// Regressions from the third audit. Every test here failed before its fix.
import test from "node:test";
import assert from "node:assert/strict";

import { LogBuffer } from "../dist/logs/buffer.js";
import { parseLine, pairFailures } from "../dist/logs/classify.js";
import { suppressedBy } from "../dist/runner/assert.js";
import { validateSpec, SpecError } from "../dist/spec/schema.js";
import { crawlToMachineReport, toJUnit, toJson } from "../dist/report/machine.js";
import { doType } from "../dist/runner/actions.js";

const win = (lines) => {
  const b = new LogBuffer();
  for (const l of lines) b.append(l, "stdout");
  return b.slice(0).map(parseLine);
};

// --- an async failure must not be silenced by another module's ignore entry ---

test("an async call's failure is attributed to its own module", () => {
  // pairFailures read the module only from call_started/call_dispatched, so an
  // async dispatch — which carries only a method — paired as "?.getJob". The
  // "?" widening in matchesCall then let a QUALIFIED entry for a DIFFERENT
  // module match it: ignore_calls: ["medusa_core.getJob"] silenced
  // their_core.getJob's timeout. A false PASS.
  const [f] = [...pairFailures(win([
    'LogosAPIClient: getToken for module: "their_core"',
    '[LogosObject] LogosAPIConsumer: async calling via LogosObject::callMethodAsync "getJob"',
    '[LogosObject] RemoteLogosObject::callMethodAsync "getJob" args: 0',
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
  ])).values()];
  assert.equal(f.module, "their_core");
  assert.equal(suppressedBy(f, ["medusa_core.getJob"]), false, "another module's entry must not silence it");
  assert.equal(suppressedBy(f, ["their_core.getJob"]), true, "its own still does");
});

// --- the spec header must mean what it says ----------------------------------

test("a scalar ignore_calls in a header is rejected, not dropped", () => {
  // Silently dropped, so a setup profile's ignore list vanished and every inert
  // control then read `ran` because a background poll landed in its window.
  assert.throws(
    () => validateSpec({ app: "a", ignore_calls: "mod.poll", steps: [{ click: "Go" }] }),
    (e) => e instanceof SpecError && /must be a list/.test(e.message),
  );
});

test("every header key is checked, and unknown ones are refused", () => {
  for (const [doc, re] of [
    [{ app: 5, steps: [] }, /`app` must be a string/],
    [{ headless: "yes", steps: [] }, /must be true or false/],
    [{ with: "core", steps: [] }, /must be a list/],
    [{ timeout: {}, steps: [] }, /must be a number/],
    [{ tiemout: "30s", steps: [] }, /unknown key `tiemout`/],
  ]) {
    assert.throws(() => validateSpec(doc), (e) => e instanceof SpecError && re.test(e.message), JSON.stringify(doc));
  }
});

test("a bad duration fails at validation, not after launching Basecamp", () => {
  assert.throws(
    () => validateSpec({ timeout: "10 seconds", steps: [{ click: "Go" }] }),
    (e) => e instanceof SpecError && /cannot parse timeout/.test(e.message),
  );
  assert.doesNotThrow(() => validateSpec({ timeout: "30s", steps: [{ click: "Go" }] }));
  assert.doesNotThrow(() => validateSpec({ timeout: 30000, steps: [{ click: "Go" }] }));
});

// --- the artifact must never disagree with the exit code ---------------------

const crawl = (over = {}) =>
  crawlToMachineReport({
    version: "0.1.0", app: "my_app", basecamp: "/x",
    fidelity: { fidelity: "verbose", qtLogLines: 1, moduleLogLines: 0, summary: "", remedy: "" },
    durationMs: 10, open: { ok: true, errors: [] }, clicks: [], ...over,
  });

test("a control whose gesture threw is a failure in the artifact", () => {
  // It bumped `problems` — so the process exited 1 — then `continue`d before
  // results.push, leaving JUnit reporting failures="0".
  const m = crawl({ unclickable: [{ label: "Send", why: "node vanished" }] });
  assert.equal(m.verdict, "fail");
  assert.match(toJUnit(m), /failures="1"/);
  assert.match(toJUnit(m), /node vanished/);
});

test("failures outside any click reach the artifact", () => {
  const m = crawl({ orphanFailures: ["mod.poll"] });
  assert.equal(m.verdict, "fail");
  assert.match(toJUnit(m), /mod\.poll failed/);
});

test("problems seen while opening reach the artifact", () => {
  const m = crawl({ openProblems: ["mod.init failed while opening"] });
  assert.equal(m.verdict, "fail");
  assert.match(toJson(m), /failed while opening/);
});

test("step indices stay unique with every optional section present", () => {
  const m = crawl({
    setupFailed: "s", endedEarly: "e", orphanFailures: ["a"],
    unclickable: [{ label: "x", why: "y" }],
    clicks: [{ label: "c", outcome: "worked", evidence: [], calls: [] }],
  });
  const idx = m.steps.map((s) => s.index);
  assert.equal(new Set(idx).size, idx.length, `indices collide: ${idx}`);
});

// --- typing must not claim what it did not verify ----------------------------

function fieldInspector({ readBack, throwOnRead = false }) {
  return {
    getTree: async () => ({
      tree: { id: "f", type: "TextField_QMLTYPE_1", text: "", visible: true, enabled: true, children: [] },
    }),
    findByProperty: async () => ({ matches: [] }),
    getProperties: async () => {
      if (throwOnRead) throw new Error("no such property");
      return { properties: readBack === undefined ? [] : [{ name: "text", value: readBack }] };
    },
    setProperty: async () => ({}),
    sendKeys: async () => ({}),
    callMethod: async () => ({}),
    clickRef: async () => ({}),
    evaluate: async () => ({ result: true, undefined: false }),
  };
}

test("typing into a field it cannot read back says so", () => {
  // An editable ComboBox or SpinBox has no `text`, so the read returns nothing
  // and sendKeys was simply trusted — reported as a plain success.
  return doType(
    { inspector: fieldInspector({ readBack: undefined }), scopeId: null },
    { into: { type: "TextField" }, text: "hunter2" },
  ).then((r) => {
    assert.match(r.detail, /not confirmed/, r.detail);
  });
});

test("typing that lands is reported plainly", () => {
  return doType(
    { inspector: fieldInspector({ readBack: "hunter2" }), scopeId: null },
    { into: { type: "TextField" }, text: "hunter2" },
  ).then((r) => {
    assert.doesNotMatch(r.detail, /not confirmed/);
    assert.match(r.detail, /typed "hunter2"/);
  });
});
