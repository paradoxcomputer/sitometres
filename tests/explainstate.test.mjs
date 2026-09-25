// A false compound `state:` names the clauses that are false. These pin the parsing that
// decides what a "clause" is, so a string or a call argument containing && never splits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { topLevelConjuncts, comparisonLhs } from "../dist/runner/assert.js";

test("splits on top-level && only", () => {
  assert.deepEqual(
    topLevelConjuncts("root.a === 'x' && f(b && c) && [1 && 2].length > 0 && s.indexOf('p && q') >= 0"),
    ["root.a === 'x'", "f(b && c)", "[1 && 2].length > 0", "s.indexOf('p && q') >= 0"],
  );
});

test("a single clause is left alone", () => {
  assert.deepEqual(topLevelConjuncts("root.walletState === 'locked'"), ["root.walletState === 'locked'"]);
});

test("escaped quotes do not end a string", () => {
  assert.deepEqual(topLevelConjuncts("a === 'it\\'s && fine' && b"), ["a === 'it\\'s && fine'", "b"]);
});

test("the left operand of a top-level comparison", () => {
  assert.equal(comparisonLhs("root.walletState === 'locked'"), "root.walletState");
  assert.equal(comparisonLhs("root.notice.indexOf('a === b') === 0"), "root.notice.indexOf('a === b')");
  assert.equal(comparisonLhs("accountModel.count >= 1"), "accountModel.count");
  assert.equal(comparisonLhs("f(x === 1)"), null);
  assert.equal(comparisonLhs("connectSheet.visible"), null);
});

import { reportableValue } from "../dist/runner/assert.js";

test("a value that looks like a recovery phrase or a key is never printed", () => {
  const phrase = '"idea expect palm rigid scorpion forward afford confirm brave divorce castle tip"';
  assert.match(reportableValue(phrase), /^<redacted: \d+ chars that look like a secret>$/);
  assert.match(reportableValue('"10a26a9aec7d34b82364eeae45c5294dbb0a764b000b94eeb9b58511dc487c4d"'), /^<redacted/);
  assert.equal(reportableValue('"locked"'), '"locked"');
  assert.equal(reportableValue('"Connect failed: no account in the request belongs to this wallet"'),
    '"Connect failed: no account in the request belongs to this wallet"');
  assert.equal(reportableValue("-1"), "-1");
});

// --- explainFalse itself: the whole point topLevelConjuncts/comparisonLhs/
// reportableValue above exist for, and until now the only one of the four
// never actually driven through a failing `state:` check.
import { runChecks } from "../dist/runner/assert.js";

const emptySnapshot = { nodes: [], labels: () => [], clickTargetFor: (n) => ({ target: n, via: "self" }) };
const ctx = (inspector, over = {}) => ({
  inspector,
  snapshot: emptySnapshot,
  window: [],
  qmlRootId: "root-1",
  appName: "tip_jar",
  logsUsable: true,
  ignoreCalls: [],
  cursor: 0,
  ...over,
});

test("a false compound state: names its false clause and the value its left side held", async () => {
  const inspector = {
    evaluate: async (expr) => {
      if (expr === "root.a === 1 && root.b === 2") return { result: false };
      if (expr === "root.a === 1") return { result: false };
      if (expr === "root.b === 2") return { result: true };
      if (expr === "JSON.stringify(root.a)") return { result: "5" };
      throw new Error(`unexpected eval: ${expr}`);
    },
  };
  const checks = await runChecks(ctx(inspector), { state: ["root.a === 1 && root.b === 2"] });
  const check = checks.find((c) => c.kind === "state");
  assert.equal(check.verdict, "fail");
  assert.match(check.detail, /false: root\.a === 1 {2}\[root\.a = 5\]/, check.detail);
  assert.doesNotMatch(check.detail, /root\.b/, "the clause that held true is not named");
});

test("a single-clause state: failure explains nothing extra — explainFalse is a no-op below two clauses", async () => {
  const inspector = { evaluate: async () => ({ result: false }) };
  const checks = await runChecks(ctx(inspector), { state: ["root.locked"] });
  const check = checks.find((c) => c.kind === "state");
  assert.equal(check.verdict, "fail");
  assert.equal(check.detail, "evaluated to false", "no clause breakdown for an expression that was never a compound");
});
