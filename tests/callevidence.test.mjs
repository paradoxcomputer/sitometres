// Reading backend-call activity out of the log, for BOTH dispatch styles.
//
// The lines here are copied verbatim from the real corpus in
// ~/.local/share/Logos/LogosBasecampDev/logs. Measured over that corpus: 936
// asynchronous dispatches occur and not one of them emits the
// `invoking remote method` line the assertion engine used to require, so every
// `logos.callModuleAsync` call was invisible — `calls:` could not pass for one,
// and `no_calls:` passed when the call HAD been made.
import test from "node:test";
import assert from "node:assert/strict";

import { LogBuffer } from "../dist/logs/buffer.js";
import { parseLine, callsIn, callName, pairFailures } from "../dist/logs/classify.js";
import { runChecks, observedCalls, verdictOf } from "../dist/runner/assert.js";

const windowOf = (lines) => {
  const b = new LogBuffer();
  for (const l of lines) b.append(l, "stdout");
  return b.slice(0).map(parseLine);
};

// Verbatim from basecamp_*.log — the full resolve-then-dispatch sequence.
const ASYNC_CALL = [
  'LogosAPIClient: getToken for module: "package_manager"',
  'LogosAPIClient: Found token for module: "package_manager"',
  'RemoteTransportConnection: Requesting object: "package_manager" at "15:28:14.953"',
  '[LogosObject] RemoteTransportConnection: returning RemoteLogosObject for: "package_manager"',
  "[LogosObject] Created RemoteLogosObject wrapping QRemoteObjectReplica 874987136",
  '[LogosObject] LogosAPIConsumer: async calling via LogosObject::callMethodAsync "getInstalledPackages"',
  '[LogosObject] RemoteLogosObject::callMethodAsync "getInstalledPackages" args: 0',
];
const SYNC_CALL = [
  'LogosAPIClient: invoking remote method "medusa_core" "connectRequest" args_count: 1',
  '[LogosObject] RemoteLogosObject::callMethod "connectRequest" args: 1',
];

const ctx = (lines, over = {}) => ({
  inspector: null,
  snapshot: { nodes: [], labels: () => [], clickTargetFor: (n) => ({ target: n, via: "self" }) },
  window: windowOf(lines),
  qmlRootId: null,
  appName: "tip_jar",
  logsUsable: true,
  ignoreCalls: [],
  cursor: 0,
  ...over,
});

test("an async dispatch is observed, qualified with its module", () => {
  const calls = callsIn(windowOf(ASYNC_CALL));
  assert.equal(calls.length, 1, "exactly one call — the two async lines are one dispatch");
  assert.equal(callName(calls[0]), "package_manager.getInstalledPackages");
  assert.equal(calls[0].async, true);
});

test("sync and async dispatches are both counted, and not double-counted", () => {
  const calls = callsIn(windowOf([...SYNC_CALL, ...ASYNC_CALL]));
  assert.deepEqual(calls.map(callName).sort(), [
    "medusa_core.connectRequest",
    "package_manager.getInstalledPackages",
  ]);
});

test("calls: passes for a call made asynchronously", async () => {
  const checks = await runChecks(ctx(ASYNC_CALL), { calls: ["package_manager.getInstalledPackages"] });
  assert.equal(checks.find((c) => c.kind === "calls").verdict, "pass");
  assert.equal(verdictOf(checks), "pass");
});

test("no_calls FAILS for a call made asynchronously", async () => {
  // The false pass this whole change exists for.
  const checks = await runChecks(ctx(ASYNC_CALL), { noCalls: ["package_manager.getInstalledPackages"] });
  assert.equal(checks.find((c) => c.kind === "noCalls").verdict, "fail");
});

test("an async call with no module context is reported, not dropped", async () => {
  const orphan = ['[LogosObject] LogosAPIConsumer: async calling via LogosObject::callMethodAsync "doThing"'];
  assert.deepEqual(observedCalls(windowOf(orphan)), ["?.doThing"]);
  // Dropping it is what let no_calls pass; matching it on the method is the
  // honest reading, since the method demonstrably fired.
  const checks = await runChecks(ctx(orphan), { noCalls: ["some_module.doThing"] });
  assert.equal(checks.find((c) => c.kind === "noCalls").verdict, "fail");
});

test("ignore_calls silences an async poll too", () => {
  const seen = observedCalls(windowOf([...ASYNC_CALL, ...SYNC_CALL]), ["package_manager.getInstalledPackages"]);
  assert.deepEqual(seen, ["medusa_core.connectRequest"]);
});

test("an ignore entry cannot silence a failure it does not own", async () => {
  // A poll and the call under test were both in flight; the pairing is
  // positional, so it lands on the poll with the real call as an alternative.
  // Suppressing that swallowed the timeout of the very call being tested.
  const overlapping = [
    'LogosAPIClient: invoking remote method "medusa_core" "sendTip" args_count: 1',
    '[LogosObject] RemoteLogosObject::callMethod "sendTip" args: 1',
    '[LogosObject] RemoteLogosObject::callMethod "pendingRequests" args: 0',
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
  ];
  const checks = await runChecks(ctx(overlapping, { ignoreCalls: ["medusa_core.pendingRequests"] }), {});
  const c = checks.find((k) => k.kind === "callsSucceed");
  assert.equal(c.verdict, "fail", "the failure must survive the ignore list");
  assert.match(c.detail, /sendTip/, "and must name the call it might really have been");
});

test("an unambiguous failure of an ignored call is still silenced", async () => {
  const onlyPoll = [
    'LogosAPIClient: invoking remote method "medusa_core" "pendingRequests" args_count: 0',
    '[LogosObject] RemoteLogosObject::callMethod "pendingRequests" args: 0',
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
  ];
  const checks = await runChecks(ctx(onlyPoll, { ignoreCalls: ["medusa_core.pendingRequests"] }), {});
  assert.equal(checks.find((k) => k.kind === "callsSucceed"), undefined);
});

test("every failure in a burst is reported", () => {
  const lines = ['[LogosObject] RemoteLogosObject::callMethod "poll" args: 0'];
  for (let i = 0; i < 22; i++) lines.push("RemoteLogosObject: callRemoteMethod failed or timed out: 1");
  const paired = [...pairFailures(windowOf(lines)).values()];
  assert.equal(paired.length, 22, "22 real failures used to report as 1, leaving the step green");
  assert.equal(paired.filter((f) => f.confident).length, 1, "only the anchored one is confident");
});

// --- the crawl and the spec runner must grade the same window the same way ---

test("an ignore entry does not silence another module's identically-named call", async () => {
  // The crawl matched entry.endsWith("." + method), so "medusa_core.getJob"
  // silenced ANY module's getJob — the defect that motivated emptying the
  // hardcoded list, still live in the crawl's own matcher.
  const { classifyOutcome } = await import("../dist/runner/outcome.js");
  const lines = [
    'LogosAPIClient: invoking remote method "their_core" "getJob" args_count: 0',
    '[LogosObject] RemoteLogosObject::callMethod "getJob" args: 0',
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
  ];
  const r = classifyOutcome({
    window: windowOf(lines),
    newLabels: [],
    appName: "my_app",
    logsUsable: true,
    ignoreCalls: ["medusa_core.getJob"],
  });
  assert.equal(r.failedCalls.length, 1, "another module's getJob must still be reported");
});

test("the crawl and the spec runner agree on what an ignore list hides", async () => {
  const { classifyOutcome } = await import("../dist/runner/outcome.js");
  const lines = [
    'LogosAPIClient: invoking remote method "my_core" "poll" args_count: 0',
    '[LogosObject] RemoteLogosObject::callMethod "poll" args: 0',
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
  ];
  for (const form of ["my_core.poll", "poll", "my_core.*"]) {
    const crawl = classifyOutcome({
      window: windowOf(lines),
      newLabels: [],
      appName: "my_app",
      logsUsable: true,
      ignoreCalls: [form],
    });
    const spec = await runChecks(ctx(lines, { ignoreCalls: [form] }), {});
    assert.deepEqual(crawl.failedCalls, [], `crawl should ignore via ${form}`);
    assert.equal(spec.find((c) => c.kind === "callsSucceed"), undefined, `spec should ignore via ${form}`);
  }
});

test("an unattributable failure is reported, not blamed on the step", async () => {
  // A failure with no module, no method and no dispatch in the window to match it to cannot
  // be shown to belong to this step — and in an app that polls it usually does not: a
  // background poll fails on its own schedule and lands in whichever window is open.
  //
  // It used to FAIL the step. The only escape was `calls_succeed: false`, which also
  // disables the check for the failures that ARE attributable — so the honest reading of the
  // evidence cost you the part of the check that works. It is inconclusive now.
  const lines = ["RemoteLogosObject: callRemoteMethod failed or timed out: 1"];
  const checks = await runChecks(ctx(lines), {});
  const c = checks.find((k) => k.kind === "callsSucceed");
  assert.equal(c.verdict, "inconclusive");
  assert.doesNotMatch(c.detail, /but\s+were also in flight/, "the broken hedged prose must be gone");
  assert.match(c.detail, /rather than blamed on this step/);
  assert.match(c.detail, /\(unknown\)/, "and it must name the form that drops it entirely");
  // Inconclusive is not a pass: verdictOf still refuses to call the step green.
  assert.equal(verdictOf(checks), "inconclusive");

  const suppressed = await runChecks(ctx(lines, { ignoreCalls: ["(unknown)"] }), {});
  assert.equal(suppressed.find((k) => k.kind === "callsSucceed"), undefined);
});

test("an ATTRIBUTABLE failure still fails the step", async () => {
  // The other half of the change above: softening the unanchored case must not soften the
  // case the check exists for. A failure that pairs with a dispatch in the window names a
  // call, and that still fails.
  const lines = [...SYNC_CALL, "RemoteLogosObject: callRemoteMethod failed or timed out: 1"];
  const checks = await runChecks(ctx(lines), {});
  const c = checks.find((k) => k.kind === "callsSucceed" && k.verdict === "fail");
  assert.ok(c, "an attributable failure must still fail the step");
  assert.match(c.detail, /connectRequest/, "and it must name the call");
  assert.equal(verdictOf(checks), "fail");
});
