// Regressions from the fourth audit. Most of these were introduced by the third
// round's fixes; every one failed before the fix here.
import test from "node:test";
import assert from "node:assert/strict";

import { LogBuffer } from "../dist/logs/buffer.js";
import { parseLine, pairFailures } from "../dist/logs/classify.js";
import { suppressedBy } from "../dist/runner/assert.js";
import { classifyOutcome } from "../dist/runner/outcome.js";
import { validateSpec } from "../dist/spec/schema.js";
import { crawlToMachineReport, toJUnit } from "../dist/report/machine.js";
import { doType } from "../dist/runner/actions.js";

const win = (lines) => {
  const b = new LogBuffer();
  for (const l of lines) b.append(l, "stdout");
  return b.slice(0).map(parseLine);
};
const call = (mod, method) => [
  `LogosAPIClient: invoking remote method "${mod}" "${method}" args_count: 0`,
  `[LogosObject] RemoteLogosObject::callMethod "${method}" args: 0`,
];
const FAIL = "RemoteLogosObject: callRemoteMethod failed or timed out: 1";

const graded = (over = {}) =>
  classifyOutcome({
    window: win([]), newLabels: [], newMessageLabels: [],
    appName: "my_app", logsUsable: true, ignoreCalls: [], ...over,
  });

// --- a failure must never vanish from the exit code --------------------------

test("a hedged failure is surfaced for counting, even though it accuses nobody", () => {
  // Grading it `unclear` and counting it NOWHERE is how the crawl came to exit
  // 0 with JUnit failures="0" on an app whose backend call failed. One click
  // dispatching two calls is enough — no polling needed.
  const r = graded({ window: win([...call("core", "getBalance"), ...call("core", "getHistory"), FAIL]) });
  assert.equal(r.outcome, "unclear", "the control is not accused");
  assert.equal(r.hedgedFailures.length, 1, "but the failure is reported for the run to count");
  assert.match(r.hedgedFailures[0], /core\.(getBalance|getHistory)/);
});

test("a confident failure still fails the click", () => {
  const r = graded({ window: win([...call("core", "doThing"), FAIL]) });
  assert.equal(r.outcome, "failed");
  assert.deepEqual(r.hedgedFailures, []);
});

// --- a failure carries its own module ----------------------------------------

test("a failure is stamped with the module that dispatched it", () => {
  // lastModule was read at the FAILURE line, so a token request for an
  // unrelated module — 178k of those in the corpus — renamed the victim, and
  // suppressedBy then keyed on the wrong name.
  const [f] = [...pairFailures(win([
    ...call("core", "doThing"),
    'LogosAPIClient: getToken for module: "other_core"',
    FAIL,
  ])).values()];
  assert.equal(f.module, "core", "the module comes from the dispatch, not from whoever last asked for a token");
  assert.equal(suppressedBy(f, ["other_core.doThing"]), false);
  assert.equal(suppressedBy(f, ["core.doThing"]), true);
});

// --- the CI gate ------------------------------------------------------------

const crawl = (over = {}) =>
  crawlToMachineReport({
    version: "0.1.0", app: "a", basecamp: "/x",
    fidelity: { fidelity: "verbose", qtLogLines: 1, moduleLogLines: 0, summary: "", remedy: "" },
    durationMs: 1, open: { ok: true, errors: [] }, clicks: [], ...over,
  });

test("a conclusive observation is not reported as skipped", () => {
  // `ran` and `nothing` were mapped to inconclusive, so --strict failed every
  // healthy crawl and there was no usable gate at all.
  const m = crawl({ clicks: [
    { label: "A", outcome: "ran", evidence: [], calls: ["m.x"] },
    { label: "B", outcome: "nothing", evidence: [], calls: [] },
  ]});
  assert.equal(m.verdict, "pass");
  assert.match(toJUnit(m), /skipped="0"/);
});

test("unclear is the one thing that is genuinely inconclusive", () => {
  const m = crawl({ clicks: [{ label: "A", outcome: "unclear", evidence: [], calls: [] }] });
  assert.equal(m.verdict, "inconclusive");
  assert.match(toJUnit(m), /skipped="1"/);
});

test("a crawl that clicked nothing does not report a pass", () => {
  // Four ways to get here — everything destructive, --skip, --limit 0, all
  // unreachable — and all of them produced one passing testcase.
  const m = crawl({ clicks: [] });
  assert.equal(m.verdict, "inconclusive");
  assert.match(toJUnit(m), /skipped="1"/);
});

// --- a header block that is entirely commented out ---------------------------

test("a commented-out header block means 'not set', not 'invalid'", () => {
  // YAML parses it as null. Rejecting it meant a setup profile was refused,
  // then swallowed — so the crawl ran with no setup AND no ignore list, which
  // is precisely what per-app-call-noise existed to prevent.
  for (const key of ["ignore_calls", "with", "timeout", "app", "basecamp", "headless"]) {
    const spec = validateSpec({ [key]: null, steps: [{ click: "Go" }] });
    assert.equal(spec[key === "ignore_calls" ? "ignoreCalls" : key], undefined, key);
  }
});

test("a real wrong type is still rejected", () => {
  assert.throws(() => validateSpec({ ignore_calls: "mod.poll", steps: [{ click: "Go" }] }), /must be a list/);
});

// --- typing that did not land ------------------------------------------------

const fieldInspector = (readBack) => ({
  getTree: async () => ({
    tree: { id: "f", type: "TextField_QMLTYPE_1", text: "", visible: true, enabled: true, children: [] },
  }),
  findByProperty: async () => ({ matches: [] }),
  getProperties: async () => ({ properties: readBack === undefined ? [] : [{ name: "text", value: readBack }] }),
  setProperty: async () => ({}),
  sendKeys: async () => ({}),
  callMethod: async () => ({}),
  clickRef: async () => ({}),
  evaluate: async () => ({ result: true, undefined: false }),
});

test("a type step that could not confirm the text returns a check, not just prose", () => {
  // The knowledge survived only in the detail string, so the step reported PASS
  // with checks: [] and JUnit emitted a bare passing testcase.
  return doType({ inspector: fieldInspector(undefined), scopeId: null },
    { into: { type: "TextField" }, text: "hunter2" }).then((r) => {
    assert.ok(r.check, "the action must hand back what it learned");
    assert.equal(r.check.verdict, "inconclusive");
  });
});

test("a field that shows something else is inconclusive, not failed", () => {
  // `verified === false` proves only that the text does not CONTAIN the input —
  // an inputMask produces exactly that on a field that took it correctly.
  return doType({ inspector: fieldInspector("(555) 123"), scopeId: null },
    { into: { type: "TextField" }, text: "5551234567" }).then((r) => {
    assert.equal(r.check.verdict, "inconclusive");
    assert.match(r.check.detail, /formatter or input mask/);
  });
});

test("typing that lands cleanly returns no check", () => {
  return doType({ inspector: fieldInspector("hunter2"), scopeId: null },
    { into: { type: "TextField" }, text: "hunter2" }).then((r) => {
    assert.equal(r.check, undefined);
  });
});
