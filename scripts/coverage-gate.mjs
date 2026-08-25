#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Fail the build when a function in the tool is executed by nothing.
//
// Two things this gate has to get right, both of which the first version got
// wrong.
//
// It measures the TOOL, not the run. Node's own summary row averages every file
// it loaded, tests included — and the tests grade themselves at 94%, so the
// headline read 87% while the tool's own function coverage was 74.7%. A number
// that flatters itself is the same defect as a verdict that claims more than it
// proved, and it is the reason three audits walked past `assessFidelity`.
//
// And it measures FUNCTIONS, not lines. A module that is merely imported scores
// lines for its top level while none of its behaviour runs: `fidelity.js` sat
// at 46% lines and 0% functions, and it was the single most load-bearing
// function in the tool's honesty story.
//
// UNREACHED is not a budget. It is the list of functions whose behaviour cannot
// be reached without something the suite is not allowed to require, each with
// the reason. A function that drifts out of coverage without an entry fails
// here, by name.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `file#function` -> why it cannot be reached. Empty is the goal. */
const UNREACHED = new Map([]);

const lcov = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sito-cov-")), "cov.lcov");
const res = spawnSync(
  process.execPath,
  [
    "--test",
    "--experimental-test-coverage",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${lcov}`,
    ...process.argv.slice(2),
  ],
  { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
);
process.stdout.write(res.stdout ?? "");
process.stderr.write(res.stderr ?? "");
if (res.status !== 0) {
  console.error("\ncoverage gate: the test run itself failed");
  process.exit(res.status ?? 1);
}

const text = fs.readFileSync(lcov, "utf8");
fs.rmSync(path.dirname(lcov), { recursive: true, force: true });

/** FN: declares a function, FNDA: records how many times it ran. */
let file = null;
const declared = new Map();
const ran = new Map();
for (const line of text.split("\n")) {
  if (line.startsWith("SF:")) {
    file = line.slice(3);
    declared.set(file, new Map());
    ran.set(file, new Map());
  } else if (line.startsWith("FN:") && file) {
    const [at, ...rest] = line.slice(3).split(",");
    declared.get(file).set(rest.join(","), Number(at));
  } else if (line.startsWith("FNDA:") && file) {
    const [count, ...rest] = line.slice(5).split(",");
    ran.get(file).set(rest.join(","), Number(count));
  }
}

const isTool = (f) => f.startsWith("dist/") && !f.endsWith(".d.ts");
const toolFiles = [...declared.keys()].filter(isTool);
if (toolFiles.length === 0) {
  console.error("coverage gate: no dist/ files in the coverage report — did the build run?");
  process.exit(1);
}

let total = 0;
let covered = 0;
const missing = [];
for (const f of toolFiles.sort()) {
  for (const [name, at] of declared.get(f)) {
    total++;
    if ((ran.get(f).get(name) ?? 0) > 0) covered++;
    else missing.push({ key: `${f}#${name}`, f, name, at });
  }
}

const pct = ((covered / total) * 100).toFixed(1);
const unexpected = missing.filter((m) => !UNREACHED.has(m.key));
const nowCovered = [...UNREACHED.keys()].filter((k) => !missing.some((m) => m.key === k));

console.log(`\ncoverage gate: ${covered}/${total} functions in dist/ executed (${pct}%)`);

if (nowCovered.length > 0) {
  console.error("\ncoverage gate: these are covered now — delete their UNREACHED entries:");
  for (const k of nowCovered) console.error(`  ${k}`);
}
if (unexpected.length > 0) {
  console.error(`\ncoverage gate: ${unexpected.length} function(s) that no test executes:`);
  const byFile = new Map();
  for (const m of unexpected) {
    if (!byFile.has(m.f)) byFile.set(m.f, []);
    byFile.get(m.f).push(m);
  }
  for (const [f, fns] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    console.error(`  ${f}`);
    for (const m of fns.sort((a, b) => a.at - b.at)) console.error(`      L${String(m.at).padEnd(5)} ${m.name}`);
  }
  console.error(
    "\nA function nothing calls is a function nothing can regress safely. Write a test,\n" +
      "or add `file#name` to UNREACHED in scripts/coverage-gate.mjs with the reason it\n" +
      "cannot be reached. Do not add one to make the number move.",
  );
}
process.exit(unexpected.length > 0 || nowCovered.length > 0 ? 1 : 0);
