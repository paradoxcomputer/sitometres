// `comment:` is the author's own words, and it is not evidence.
//
// The key was parsed and allowlisted by the step validator, then read at
// exactly two places, both of them breakpoint detection. So a spec that said
// why a step existed said it to nobody: the prose reached no terminal line, no
// JSON step record and no JUnit file, while `text:` in doctest — the same idea
// in a sibling tool — renders at that point in the sequence.
//
// Carrying it has one hard edge. A check's `description` and `detail` are what
// this run FOUND; `comment:` was written before the run existed. Prose sitting
// in either place reads as a claim the tool never made, which is the invariant
// every verdict here rests on. So it travels in a field of its own, is rendered
// next to the step's NAME, and appears in no JUnit body at all.
//
// The rendering itself is pinned in tests/terminalprint.test.mjs, next to the
// other printStep assertions.
import test from "node:test";
import assert from "node:assert/strict";

import { commentProse, Runner } from "../dist/runner/runner.js";
import { LogBuffer } from "../dist/logs/buffer.js";
import { toJson, toJUnit } from "../dist/report/machine.js";

// --- which comments are prose, and which are directives ----------------------

test("a breakpoint marker is a directive, so only the words after it are prose", () => {
  // README, SKILL and the shipped example all spell a breakpoint
  // `comment: "# breakpoint: <why>"`. The marker is an instruction to the
  // runner; printing it back would describe a pause to a reader of a CI run
  // that has no --debug and never paused.
  assert.equal(commentProse("# breakpoint: check state after login"), "check state after login");
  assert.equal(commentProse("# breakpoint"), undefined);
  assert.equal(commentProse("breakpoint"), undefined);
  assert.equal(commentProse("# Breakpoint here"), undefined, "case is not a signal, and neither is a bare word after it");
});

test("ordinary prose survives whole, colons included", () => {
  assert.equal(
    commentProse("# the ledger must not move until the tip settles"),
    "the ledger must not move until the tip settles",
  );
  assert.equal(
    commentProse("amount: 10 sats is below the dust limit"),
    "amount: 10 sats is below the dust limit",
    "a colon is not a marker; only a leading breakpoint directive is stripped",
  );
  assert.equal(
    commentProse("# do not set a breakpointish marker"),
    "do not set a breakpointish marker",
    "the same word boundary isBreakpointComment reads by",
  );
});

test("a comment with no sentence in it produces nothing", () => {
  // The `#` is decoration carried over from writing YAML comments, not part of
  // the sentence, so a comment that is only decoration is not intent.
  assert.equal(commentProse(undefined), undefined);
  assert.equal(commentProse(""), undefined);
  assert.equal(commentProse("   "), undefined);
  assert.equal(commentProse("#"), undefined);
});

test("a comment YAML parsed into something that is not a string does not take the run down", () => {
  // `comment: # breakpoint` — unquoted, the way a YAML comment is written
  // everywhere else — parses as null, and validateStep allowlists the key
  // without checking its type. isBreakpointComment survived that only because
  // RegExp.test stringifies what it is given; .replace does not.
  assert.equal(commentProse(null), undefined);
  assert.equal(commentProse(42), undefined);
  assert.equal(commentProse(["a"]), undefined);
});

// --- it reaches the step record ----------------------------------------------

/** Enough of a session for the Runner to drive with no Basecamp anywhere. */
function fakeSession() {
  return {
    logs: new LogBuffer(),
    inspector: {
      getTree: async () => ({ tree: { id: "root", type: "Item", children: [] } }),
      evaluate: async () => ({ result: true, undefined: false }),
      screenshot: async () => ({ image: "" }),
      clickRef: async () => ({}),
    },
  };
}

const run = (steps) =>
  new Runner({
    session: fakeSession(),
    spec: { app: "a", timeout: "1s", steps },
    appName: "a",
    logsUsable: false,
    settleMs: 10,
    // The "later steps were not attempted" note is the caller's line, not this
    // test's output.
    onNote: () => {},
  }).run();

test("a step's comment travels with its result, and never inside a check", async () => {
  const result = await run([
    {
      name: "check the ladder",
      comment: "# the ladder must be empty before the first bid",
      expect: { state: "root.ok" },
    },
  ]);
  const step = result.steps[0];
  assert.equal(
    step.comment,
    "the ladder must be empty before the first bid",
    "the step record used to carry no trace of it",
  );
  assert.equal(step.verdict, "inconclusive", "and it decides nothing: there is no open app to evaluate against");
  for (const chk of step.checks) {
    assert.ok(!chk.description.includes("ladder must be empty"), "prose in a description reads as an assertion");
    assert.ok(!(chk.detail ?? "").includes("ladder must be empty"), "and in a detail it reads as evidence");
  }
});

test("a step the run never reached keeps the comment its author wrote", async () => {
  // The steps after an abort are INCONCLUSIVE rather than absent so a reader
  // can place them, and "what was this step for" is most of placing one.
  const result = await run([
    { name: "shot", screenshot: "nowhere" },
    {
      name: "later",
      comment: "# breakpoint: the balance is only correct after the tip settles",
      expect: { state: "root.ok" },
    },
  ]);
  assert.equal(result.steps[0].verdict, "fail", "the screenshot has nowhere to write, so the run stops here");
  assert.equal(result.steps[1].verdict, "inconclusive");
  assert.equal(result.steps[1].comment, "the balance is only correct after the tip settles");
});

test("a comment the runner consumed as a directive reaches no report", async () => {
  // This one passes on the code as it was, because nothing carried a comment at
  // all. It is here to pin the decision: the filter lives in the runner, so the
  // terminal and the JSON cannot disagree about what counts as prose, and a
  // bare "# breakpoint" is a directive in both.
  const marked = await run([{ name: "two", comment: "# breakpoint", expect: { state: "root.ok" } }]);
  assert.ok(!("comment" in marked.steps[0]), "a marker is an instruction, not something to narrate back");

  const plain = await run([{ name: "one", expect: { state: "root.ok" } }]);
  assert.ok(!("comment" in plain.steps[0]), "and a step with no comment carries no empty field either");
});

// --- and the machine report ---------------------------------------------------

const report = (steps) => ({
  tool: "sitometres",
  version: "0.0.0-test",
  app: "tip_jar",
  basecamp: "/nowhere",
  fidelity: { fidelity: "quiet", qtLogLines: 0, moduleLogLines: 0, summary: "no logs in this test" },
  verdict: "fail",
  durationMs: 10,
  steps,
});

const PROSE = "the ledger must not move until the tip settles";
const commented = () =>
  run([{ name: "check the ladder", comment: PROSE, expect: { state: "root.ok" } }]);

test("the JSON step record carries the comment as a field of its own", async () => {
  const result = await commented();
  const json = JSON.parse(toJson(report(result.steps)));
  assert.equal(json.steps[0].comment, PROSE, "a consumer reads intent from a field, not by parsing it out of a check");
  assert.ok(!JSON.stringify(json.steps[0].checks).includes(PROSE), "and never from the checks");
});

test("no JUnit body carries it, because every body there is something the run found", async () => {
  const result = await commented();
  const junit = toJUnit(report(result.steps));
  // Positive controls, both of them: asserting only that the prose is absent
  // would pass with toJUnit returning "".
  assert.ok(junit.includes("check the ladder"), "the step really is in the file — otherwise this proves nothing");
  assert.ok(junit.includes("QML root was not found"), "and so is the evidence that made it inconclusive");
  assert.ok(
    !junit.includes(PROSE),
    "<skipped> and <failure> say what the run found; authored prose there is a claim the tool never made",
  );
});
