// Assertion-engine tests, driven by real recorded log lines.
//
// These cover the path a Release Basecamp cannot exercise: what happens when
// the log DOES carry the call trail. Without them the verbose branch would
// ship unverified.
import test from "node:test";
import assert from "node:assert/strict";

import { LogBuffer } from "../dist/logs/buffer.js";
import { parseLine } from "../dist/logs/classify.js";
import { runChecks, verdictOf, matchesCall, observedCalls } from "../dist/runner/assert.js";
import { pairFailures } from "../dist/logs/classify.js";

const CALL_OK = [
  'LogosAPIClient: invoking remote method "medusa_core" "connectRequest" args_count: 1',
  '[LogosObject] RemoteLogosObject::callMethod "connectRequest" args: 1',
];
const CALL_FAILED = [
  'LogosAPIClient: invoking remote method "medusa_core" "getSequencerStatus" args_count: 0',
  '[LogosObject] RemoteLogosObject::callMethod "getSequencerStatus" args: 0',
  "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
];
const POLL_NOISE = [
  'LogosAPIClient: invoking remote method "medusa_core" "pendingRequests" args_count: 0',
  '[LogosObject] RemoteLogosObject::callMethod "pendingRequests" args: 0',
];

function windowOf(lines) {
  const b = new LogBuffer();
  for (const l of lines) b.append(l, "stdout");
  return b.slice(0).map(parseLine);
}

// A snapshot stub: assertions about text are covered in selector.test.mjs.
const emptySnapshot = { nodes: [], labels: () => [], clickTargetFor: (n) => ({ target: n, via: "self" }) };

function ctx(lines, over = {}) {
  return {
    inspector: null,
    snapshot: emptySnapshot,
    window: windowOf(lines),
    qmlRootId: null,
    appName: "tip_jar",
    logsUsable: true,
    ignoreCalls: [],
    cursor: 0,
    ...over,
  };
}

test("matchesCall accepts qualified, bare and wildcard forms", () => {
  assert.ok(matchesCall("medusa_core.getZones", "medusa_core.getZones"));
  assert.ok(matchesCall("medusa_core.getZones", "getZones"));
  assert.ok(matchesCall("medusa_core.getZones", "medusa_core.*"));
  assert.ok(!matchesCall("medusa_core.getZones", "other.getZones"));
  assert.ok(!matchesCall("medusa_core.getZones", "getTokens"));
});

test("an expected call that happened PASSES", async () => {
  const checks = await runChecks(ctx(CALL_OK), { calls: ["medusa_core.connectRequest"] });
  assert.equal(checks.find((c) => c.kind === "calls").verdict, "pass");
  assert.equal(verdictOf(checks), "pass");
});

test("an expected call that did not happen FAILS, and says what did", async () => {
  const checks = await runChecks(ctx(POLL_NOISE), { calls: ["medusa_core.connectRequest"] });
  const c = checks.find((k) => k.kind === "calls");
  assert.equal(c.verdict, "fail");
  assert.match(c.detail, /pendingRequests/);
});

test("an unambiguous failure is stated plainly", async () => {
  const checks = await runChecks(ctx(CALL_FAILED), {});
  const c = checks.find((k) => k.kind === "callsSucceed");
  assert.match(c.detail, /getSequencerStatus failed or timed out/);
  assert.ok(!/most likely/.test(c.detail), "should not hedge when nothing else was in flight");
});

test("a failure with other calls in flight is reported as a best guess", async () => {
  // medusa_ui polls while other calls run, so the anchor may belong to a
  // different call than the one that actually died.
  const concurrent = [
    'LogosAPIClient: invoking remote method "medusa_core" "getSecurityState" args_count: 0',
    '[LogosObject] RemoteLogosObject::callMethod "getSecurityState" args: 0',
    '[LogosObject] RemoteLogosObject::callMethod "pendingRequests" args: 0',
    '[LogosObject] RemoteLogosObject::callMethod "getWalletState" args: 0',
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
  ];
  const checks = await runChecks(ctx(concurrent), {});
  const c = checks.find((k) => k.kind === "callsSucceed");
  assert.equal(c.verdict, "fail");
  assert.match(c.detail, /most likely medusa_core\.getWalletState/);
  assert.match(c.detail, /getSecurityState/);
  assert.match(c.detail, /pendingRequests/);
  assert.match(c.detail, /best guess/);
});

test("one failure does not reuse another's anchor, and is still reported", () => {
  const two = windowOf([
    '[LogosObject] RemoteLogosObject::callMethod "alpha" args: 0',
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
  ]);
  const paired = [...pairFailures(two).values()];
  // Two failures happened, so two must be reported. This test used to assert
  // that the second one VANISHED — which is how a burst of 22 real transport
  // failures reported as one and left the step green.
  assert.equal(paired.length, 2, "every failure in the window is reported");
  assert.equal(paired[0].method, "alpha", "the first claims the anchor");
  assert.equal(paired[1].method, "(unknown)", "the second must not claim alpha");
  assert.equal(paired[1].confident, false);
});

test("a burst of failures does not collapse to one", () => {
  const lines = ['[LogosObject] RemoteLogosObject::callMethod "poll" args: 0'];
  for (let i = 0; i < 22; i++) lines.push("RemoteLogosObject: callRemoteMethod failed or timed out: 1");
  assert.equal([...pairFailures(windowOf(lines)).values()].length, 22);
});

test("a failed call is reported even when the call itself was expected", async () => {
  const checks = await runChecks(ctx(CALL_FAILED), { calls: ["medusa_core.getSequencerStatus"] });
  assert.equal(checks.find((c) => c.kind === "calls").verdict, "pass");
  const failed = checks.find((c) => c.kind === "callsSucceed");
  assert.equal(failed.verdict, "fail");
  assert.match(failed.detail, /getSequencerStatus/);
  assert.equal(verdictOf(checks), "fail");
});

test("ignore_calls silences a polling loop without hiding real calls", () => {
  const seen = observedCalls(windowOf([...POLL_NOISE, ...CALL_OK]), ["medusa_core.pendingRequests"]);
  assert.deepEqual(seen, ["medusa_core.connectRequest"]);
});

test("no_calls fails when the call was made", async () => {
  const checks = await runChecks(ctx(CALL_OK), { noCalls: ["medusa_core.connectRequest"] });
  assert.equal(checks.find((c) => c.kind === "noCalls").verdict, "fail");
});

test("a quiet build reports INCONCLUSIVE, never a false pass or a false alarm", async () => {
  const checks = await runChecks(ctx([], { logsUsable: false }), {
    calls: ["medusa_core.connectRequest"],
  });
  const c = checks.find((k) => k.kind === "calls");
  assert.equal(c.verdict, "inconclusive");
  assert.equal(verdictOf(checks), "inconclusive");
});

test("a quiet build does not litter a step that has its own evidence", async () => {
  // The anti-litter rule, and it is right: a step asserting visible text has
  // been verified, and adding INCONCLUSIVE for a default the user never asked
  // for would be noise.
  const snap = {
    nodes: [{ id: "1", type: "Text", text: "Connected", visible: true, enabled: true }],
    labels: () => ["Connected"],
    clickTargetFor: (n) => ({ target: n, via: "self" }),
  };
  const checks = await runChecks(ctx([], { logsUsable: false, snapshot: snap }), {
    text: ["Connected"],
  });
  assert.equal(checks.length, 1, "only the check the spec asked for");
  assert.equal(verdictOf(checks), "pass");
});

test("a step that could verify NOTHING is inconclusive, not a pass", async () => {
  // The other half. On a quiet session an empty expect block ran no checks at
  // all and verdictOf([]) is "pass" — so `init`'s generated step, under
  // --attach, reported a green step having checked nothing, while the README
  // promises INCONCLUSIVE there rather than an invented pass.
  const checks = await runChecks(ctx([], { logsUsable: false }), {});
  assert.equal(verdictOf(checks), "inconclusive");
  assert.match(checks[0].detail, /nothing about it was verified/);
});

test("a spec that switched the defaults off is still a pass", async () => {
  // Zero checks is legitimately a pass when the spec said so.
  const checks = await runChecks(ctx([], { logsUsable: false }), {
    callsSucceed: false,
    noErrors: false,
  });
  assert.equal(checks.length, 0);
  assert.equal(verdictOf(checks), "pass");
});

test("QML errors from the app under test fail the step; other apps' do not", async () => {
  const mine = [
    "file:///home/u/.local/share/Logos/LogosBasecampDev/plugins/tip_jar/qml/Main.qml:9: TypeError: boom",
  ];
  const theirs = [
    "file:///home/u/.local/share/Logos/LogosBasecampDev/plugins/medusa_ui/qml/Main.qml:9: TypeError: boom",
  ];
  const a = await runChecks(ctx(mine), {});
  assert.equal(a.find((c) => c.kind === "noErrors").verdict, "fail");
  const b = await runChecks(ctx(theirs), {});
  assert.equal(b.find((c) => c.kind === "noErrors").verdict, "pass");
});

test("events are matched from emitEvent lines", async () => {
  const checks = await runChecks(ctx(['[LogosProviderObject] emitEvent: "walletChanged"']), {
    events: ["walletChanged"],
  });
  assert.equal(checks.find((c) => c.kind === "events").verdict, "pass");
});

test("console assertions read the app's own qml: output", async () => {
  const ok = await runChecks(ctx(["qml: tip ready: 42"]), { console: ["tip ready: 42"] });
  assert.equal(ok.find((c) => c.kind === "console").verdict, "pass");
  const bad = await runChecks(ctx(["qml: something else"]), { console: ["never logged"] });
  const c = bad.find((k) => k.kind === "console");
  assert.equal(c.verdict, "fail");
  assert.match(c.detail, /something else/);
});

test("no_warnings is opt-in and separate from no_errors", async () => {
  const warn = [
    "file:///home/u/.local/share/Logos/LogosBasecampDev/plugins/tip_jar/qml/Main.qml:1:17: QML QQuickImage: Cannot open: file:///missing.png",
  ];
  // A missing asset is a warning: no_errors (on by default) must ignore it...
  const lenient = await runChecks(ctx(warn), {});
  assert.equal(lenient.find((c) => c.kind === "noErrors").verdict, "pass");
  assert.equal(lenient.find((c) => c.kind === "noWarnings"), undefined);
  // ...but no_warnings must catch it.
  const strict = await runChecks(ctx(warn), { noWarnings: true });
  assert.equal(strict.find((c) => c.kind === "noWarnings").verdict, "fail");
});

test("callsSucceed is named for what it can actually prove", async () => {
  const checks = await runChecks(ctx(CALL_FAILED), { calls: ["medusa_core.getSequencerStatus"] });
  const c = checks.find((k) => k.kind === "callsSucceed");
  // Not "backend calls succeeded" - a module-level error is invisible in the log.
  assert.equal(c.description, "no failed or timed-out backend calls");
});

test("verdictOf ranks fail over inconclusive over pass", () => {
  assert.equal(verdictOf([{ verdict: "pass" }, { verdict: "inconclusive" }, { verdict: "fail" }]), "fail");
  assert.equal(verdictOf([{ verdict: "pass" }, { verdict: "inconclusive" }]), "inconclusive");
  assert.equal(verdictOf([{ verdict: "pass" }]), "pass");
});
