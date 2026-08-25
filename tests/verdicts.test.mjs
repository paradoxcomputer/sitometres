// A step must never claim more than it checked.
//
// Every test here failed before its fix, and all of them were silent PASSES —
// the worst failure mode a test runner has, because a green run is the product.
import test from "node:test";
import assert from "node:assert/strict";

import { validateSpec, SpecError } from "../dist/spec/schema.js";
import { runChecks, verdictOf, isNegative, allMonotone, isIrrecoverable, settled } from "../dist/runner/assert.js";
import { Runner } from "../dist/runner/runner.js";
import { LogBuffer } from "../dist/logs/buffer.js";

const emptySnapshot = { nodes: [], labels: () => [], clickTargetFor: (n) => ({ target: n, via: "self" }) };
const ctx = (over = {}) => ({
  inspector: null,
  snapshot: emptySnapshot,
  window: [],
  qmlRootId: null,
  appName: "tip_jar",
  logsUsable: true,
  ignoreCalls: [],
  cursor: 0,
  ...over,
});

// --- scalar log expectations -------------------------------------------------

test("a scalar where a list belongs is rejected, not spread into characters", () => {
  for (const [key, yaml] of [["calls", "calls"], ["no_calls", "noCalls"], ["events", "events"]]) {
    assert.throws(
      () => validateSpec({ app: "a", steps: [{ click: "Go", expect: { [key]: "mod.doThing" } }] }),
      (e) => e instanceof SpecError && /must be a list/.test(e.message),
      `${key}: a bare string used to become one check per character, all passing`,
    );
  }
});

test("the list form is still accepted", () => {
  const spec = validateSpec({ app: "a", steps: [{ click: "Go", expect: { no_calls: ["mod.doThing"] } }] });
  assert.deepEqual(spec.steps[0].expect.noCalls, ["mod.doThing"]);
});

test("runChecks itself refuses to spread a string, even called directly", async () => {
  const checks = await runChecks(ctx(), { noCalls: "mod.doThing" });
  const noCalls = checks.filter((c) => c.kind === "noCalls");
  assert.equal(noCalls.length, 1, "one expectation, not one per character");
  assert.equal(noCalls[0].description, 'does not call mod.doThing');
});

// --- unreadable evidence -----------------------------------------------------

test("an explicitly named log expectation is INCONCLUSIVE, never a pass", async () => {
  for (const expect of [{ noWarnings: true }, { noErrors: true }, { callsSucceed: true }]) {
    const checks = await runChecks(ctx({ logsUsable: false }), expect);
    assert.equal(checks.length, 1, `${Object.keys(expect)[0]} must produce a check`);
    assert.equal(checks[0].verdict, "inconclusive");
    assert.equal(verdictOf(checks), "inconclusive", "and must not read as a pass");
  }
});

test("the implicit defaults stay silently skipped when the step has other evidence", async () => {
  // The anti-litter behaviour, and it is correct: the user never asked for the
  // default, and the step was verified by what they DID ask for.
  const snap = {
    nodes: [{ id: "1", type: "Text", text: "Ready", visible: true, enabled: true }],
    labels: () => ["Ready"],
    clickTargetFor: (n) => ({ target: n, via: "self" }),
  };
  const checks = await runChecks(ctx({ logsUsable: false, snapshot: snap }), { text: ["Ready"] });
  assert.equal(checks.length, 1);
  assert.equal(verdictOf(checks), "pass");
});

test("but a step that verified nothing at all does not pass", async () => {
  const checks = await runChecks(ctx({ logsUsable: false }), {});
  assert.equal(verdictOf(checks), "inconclusive");
});

test("verdictOf([]) is still a pass — calls_succeed: false produces it by design", () => {
  assert.equal(verdictOf([]), "pass");
});

// --- monotonicity ------------------------------------------------------------

test("negative expectations are the ones that need time to be falsified", () => {
  for (const k of ["notText", "noCalls", "noErrors", "noWarnings", "callsSucceed"]) {
    assert.ok(isNegative(k), `${k} is only ever falsified by something happening`);
  }
  for (const k of ["text", "state", "calls", "console", "events"]) {
    assert.ok(!isNegative(k), `${k} is monotone: once true it stays true`);
  }
  assert.ok(allMonotone([{ kind: "text", verdict: "pass", description: "" }]));
  assert.ok(!allMonotone([{ kind: "noCalls", verdict: "pass", description: "" }]));
  assert.ok(!allMonotone([]), "nothing checked is not a reason to return early");
});

// --- the runner --------------------------------------------------------------

/** Enough of a session for the Runner to drive with no Basecamp anywhere. */
function fakeSession({ tree = { id: "root", type: "Item", children: [] } } = {}) {
  const logs = new LogBuffer();
  return {
    logs,
    inspector: {
      getTree: async () => ({ tree }),
      evaluate: async () => ({ result: true, undefined: false }),
      screenshot: async () => ({ image: "" }),
      clickRef: async () => ({}),
    },
  };
}

test("a negative expectation is not graded before the click can land", async () => {
  const session = fakeSession();
  const runner = new Runner({
    session,
    spec: { app: "a", steps: [{ name: "no call", waitFor: undefined, expect: { noCalls: ["mod.doThing"] } }] },
    appName: "a",
    logsUsable: true,
    settleMs: 400,
  });
  // The forbidden call arrives after the gesture, as a real one would: the
  // inspector POSTS events, so nothing has been handled when the step begins.
  setTimeout(() => {
    session.logs.append('LogosAPIClient: invoking remote method "mod" "doThing" args_count: 0', "stdout");
  }, 150);
  const result = await runner.run();
  assert.equal(result.verdict, "fail", "this used to PASS in ~27ms, before the call arrived");
});

test("a step of only positive expectations still returns as soon as they hold", async () => {
  const session = fakeSession();
  const runner = new Runner({
    session,
    spec: { app: "a", steps: [{ name: "state", expect: { state: "root.ready" } }] },
    appName: "a",
    logsUsable: false,
    settleMs: 5_000,
  });
  const t0 = Date.now();
  const result = await runner.run();
  const elapsed = Date.now() - t0;
  // The verdict here is inconclusive — there is no open app to evaluate the
  // expression against — but that is monotone too: waiting cannot change it.
  assert.notEqual(result.verdict, "fail");
  assert.ok(elapsed < 2_000, `monotone checks must not wait out the settle period (took ${elapsed}ms)`);
});

test("wait_for on unreadable evidence is INCONCLUSIVE with its checks attached", async () => {
  const session = fakeSession();
  const runner = new Runner({
    session,
    spec: { app: "a", timeout: "1s", steps: [{ name: "waiting", waitFor: { calls: ["mod.doThing"] } }] },
    appName: "a",
    logsUsable: false,
    settleMs: 50,
  });
  const result = await runner.run();
  const step = result.steps[0];
  assert.ok(step.checks.length > 0, "it used to report PASS with checks: []");
  assert.equal(step.verdict, "inconclusive");
  assert.equal(result.verdict, "inconclusive");
});

test("a screenshot with nowhere to write fails instead of passing silently", async () => {
  const session = fakeSession();
  const runner = new Runner({
    session,
    spec: { app: "a", steps: [{ name: "shot", screenshot: "after-send" }] },
    appName: "a",
    logsUsable: false,
  });
  const result = await runner.run();
  assert.equal(result.steps[0].verdict, "fail");
  assert.match(result.steps[0].error, /--artifacts/);
});

// The dual of allMonotone, and the reason this file used to take 30 seconds.
// pollChecks returned early only on a CLEAN result, so a step whose negative
// expectation had already been falsified kept polling to its deadline: the
// verdict was final in the first second and the user waited out the whole 30s
// default. `notText` is deliberately excluded — it reads the live snapshot, and
// "Loading…" disappearing is exactly what a step waits for.
test("a window-based negative expectation cannot un-fail; notText can", () => {
  for (const k of ["noCalls", "noErrors", "noWarnings", "callsSucceed"]) {
    assert.ok(isIrrecoverable(k), `${k} reads the log window, which only grows`);
  }
  assert.ok(!isIrrecoverable("notText"), "text can leave the screen again");
  for (const k of ["text", "state", "calls", "console", "events"]) {
    assert.ok(!isIrrecoverable(k), `${k} is positive: it can still come true`);
  }
});

test("polling stops only when every failing check is beyond recovery", () => {
  const fail = (kind) => ({ kind, verdict: "fail", description: "" });
  const pass = (kind) => ({ kind, verdict: "pass", description: "" });
  assert.ok(settled([fail("noCalls")]));
  assert.ok(settled([pass("text"), fail("noErrors")]));
  assert.ok(!settled([]), "nothing failing is not a reason to stop early");
  assert.ok(!settled([pass("noCalls")]));
  assert.ok(
    !settled([fail("text"), fail("noCalls")]),
    "a `text:` that has not rendered yet may still come true; returning now would report it as failed",
  );
  assert.ok(!settled([fail("notText")]), "the text may still disappear");
});

test("a step that has definitively failed does not wait out its timeout", async () => {
  const session = fakeSession();
  const runner = new Runner({
    session,
    // No spec timeout, so this uses the 30s default — which is what the old
    // code spent here, and what made the whole suite 30s long.
    spec: { app: "a", steps: [{ name: "no call", expect: { noCalls: ["mod.doThing"] } }] },
    appName: "a",
    logsUsable: true,
    settleMs: 200,
  });
  // Inside the step's own window, as a real dispatch would be: the step marks
  // its log cursor when it starts, so a line appended before that is not
  // evidence about this step at all.
  setTimeout(() => {
    session.logs.append('LogosAPIClient: invoking remote method "mod" "doThing" args_count: 0', "stdout");
  }, 50);
  const t0 = Date.now();
  const result = await runner.run();
  const elapsed = Date.now() - t0;
  assert.equal(result.verdict, "fail");
  assert.ok(elapsed < 3_000, `the verdict was final in the first second; this took ${elapsed}ms`);
});

// Abandoning the rest of a spec is correct — the app is no longer where the
// spec assumes — but recording them nowhere is not. The summary, the JSON and
// the JUnit described only the steps that executed, so a spec's test count
// silently shrank: CI read tests="2" as a two-test suite that got smaller, not
// as steps that were never attempted.
test("steps a broken run never reached are inconclusive, not absent", async () => {
  const session = fakeSession();
  const runner = new Runner({
    session,
    spec: {
      app: "a",
      steps: [
        { name: "first", expect: { state: "root.ready" } },
        // No artifact directory, so this step cannot be performed at all.
        { name: "screenshot", screenshot: "after" },
        { name: "third", expect: { state: "root.ready" } },
        { name: "fourth", expect: { state: "root.ready" } },
      ],
    },
    appName: "a",
    logsUsable: false,
    settleMs: 10,
  });
  const result = await runner.run();
  assert.equal(result.steps.length, 4, "every step in the spec is accounted for");
  assert.equal(result.steps[1].verdict, "fail", "the step that could not be performed");
  assert.deepEqual(
    result.steps.slice(2).map((s) => s.verdict),
    ["inconclusive", "inconclusive"],
    "the steps after it were not attempted, which is not the same as passing",
  );
  assert.match(result.steps[2].checks[0].detail, /no longer in the state this spec assumes/);
  assert.deepEqual(result.steps.map((s) => s.name), ["first", "screenshot", "third", "fourth"]);
});

test("an expect block with everything commented out still runs the defaults", () => {
  // YAML parses `expect:` with only comments under it as null, and a null
  // expect used to skip every check — including the default "the app did not
  // throw". `sitometres init` generates exactly that block, and its own comment
  // promises that check, so the documented starting spec asserted nothing.
  const spec = validateSpec({ app: "a", steps: [{ click: "Go", expect: null }] });
  assert.deepEqual(spec.steps[0].expect, {}, "an empty block means the defaults, not nothing");
});

test("a wait_for that never comes true says what it was waiting on", async () => {
  // "waitFor never came true" on its own tells you nothing. The checks it was
  // polling — and their details — are the diagnosis.
  const session = fakeSession();
  const runner = new Runner({
    session,
    spec: {
      app: "a",
      timeout: "600ms",
      steps: [{ name: "waiting", waitFor: { notText: [], noCalls: ["mod.doThing"] } }],
    },
    appName: "a",
    logsUsable: true,
    settleMs: 50,
  });
  session.logs.append('LogosAPIClient: invoking remote method "mod" "doThing" args_count: 0', "stdout");
  setTimeout(() => {
    session.logs.append('LogosAPIClient: invoking remote method "mod" "doThing" args_count: 0', "stdout");
  }, 20);

  const result = await runner.run();
  const step = result.steps[0];
  assert.equal(step.verdict, "fail");
  assert.match(step.error, /waitFor never came true/);
  assert.match(step.error, /does not call mod\.doThing/, "and names the expectation that did not hold");
});

test("the debug REPL's log view reports the QML errors in the step's own window", async () => {
  // mark() returns a cursor just PAST the last line, so slicing from a cursor
  // taken inside the callback is empty by construction: it always said "none",
  // including when paused on a failure caused by the errors it was hiding.
  const session = fakeSession();
  session.debug = { active: false, stepNumber: 0, stepDescription: "", isBreakpoint: false, isFailure: false };
  const runner = new Runner({
    session,
    spec: { app: "a", timeout: "300ms", steps: [{ name: "one", expect: { state: "root.ok" } }] },
    appName: "a",
    logsUsable: true,
    settleMs: 10,
  });
  runner.debugPause = async () => "continue";
  const seen = [];
  // The window the REPL asks about is the step's, so the error has to arrive
  // while the step is running.
  runner.debugPause = async () => {
    session.logs.append('file:///app/qml/Main.qml:12:5: TypeError: Cannot read property "x" of null', "stderr");
    seen.push(await runner.debugCallbacks().getLogs());
    return "continue";
  };
  await runner.run();

  assert.equal(seen.length > 0, true, "the pause happened");
  assert.match(seen[0], /QML errors:/);
  assert.match(seen[0], /TypeError/, "the error itself, not the word 'none'");
});

test("a failing step in debug mode is announced with the checks that failed", async () => {
  // The pause prints the reason before handing over the prompt, and the reason
  // is the failing checks — a step can fail with no `error` at all, which is the
  // normal case: an expectation that did not hold is not an exception.
  const session = fakeSession();
  session.debug = { active: false, stepNumber: 0, stepDescription: "", isBreakpoint: false, isFailure: false };
  const runner = new Runner({
    session,
    spec: { app: "a", timeout: "400ms", steps: [{ name: "no call", expect: { noCalls: ["mod.doThing"] } }] },
    appName: "a",
    logsUsable: true,
    settleMs: 20,
  });
  let paused = 0;
  runner.debugPause = async () => (paused++, "continue");

  const printed = [];
  const log = console.log;
  console.log = (...a) => printed.push(a.join(" "));
  try {
    setTimeout(() => {
      session.logs.append('LogosAPIClient: invoking remote method "mod" "doThing" args_count: 0', "stdout");
    }, 10);
    const result = await runner.run();
    assert.equal(result.steps[0].verdict, "fail");
    assert.equal(result.steps[0].error, undefined, "a failed expectation is not an exception");
  } finally {
    console.log = log;
  }

  assert.ok(paused > 0, "it paused on the failure");
  const said = printed.join("\n");
  assert.match(said, /Step failed: no call/);
  assert.match(said, /does not call mod\.doThing/, "and says WHICH check failed, not just that one did");
});
