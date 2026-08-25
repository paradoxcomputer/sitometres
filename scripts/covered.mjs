#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Which functions does this test file actually execute?
//
//   node scripts/covered.mjs tests/wallet.test.mjs dist/app/wallet.js
//
// The gate in coverage-gate.mjs answers that for the whole suite, which is the
// wrong grain when you are writing one file: it takes a minute and tells you
// about everything. This runs one test file and prints one module's functions
// with their hit counts, so "did my test reach it?" is a two-second question.
//
// Both arguments are required, because the interesting answer is always about a
// specific pair.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [testFile, distFile] = process.argv.slice(2);
if (!testFile || !distFile) {
  console.error("usage: node scripts/covered.mjs <tests/x.test.mjs> <dist/y.js>");
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sito-covered-"));
const lcov = path.join(dir, "cov.lcov");
const res = spawnSync(
  process.execPath,
  [
    "--test",
    "--experimental-test-coverage",
    "--test-reporter=lcov",
    `--test-reporter-destination=${lcov}`,
    testFile,
  ],
  { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
);
if (!fs.existsSync(lcov)) {
  process.stderr.write(res.stderr ?? "");
  console.error("no coverage produced — did the test file run at all?");
  process.exit(1);
}

const text = fs.readFileSync(lcov, "utf8");
fs.rmSync(dir, { recursive: true, force: true });

let file = null;
const declared = new Map();
const ran = new Map();
for (const line of text.split("\n")) {
  if (line.startsWith("SF:")) file = line.slice(3);
  else if (line.startsWith("FN:") && file === distFile) {
    const [at, ...rest] = line.slice(3).split(",");
    declared.set(rest.join(","), Number(at));
  } else if (line.startsWith("FNDA:") && file === distFile) {
    const [count, ...rest] = line.slice(5).split(",");
    ran.set(rest.join(","), Number(count));
  }
}

if (declared.size === 0) {
  console.error(`${distFile} does not appear in the coverage report — is it imported by ${testFile}?`);
  process.exit(1);
}

const rows = [...declared].sort((a, b) => a[1] - b[1]);
const width = Math.max(...rows.map(([n]) => n.length));
let hit = 0;
for (const [name, at] of rows) {
  const count = ran.get(name) ?? 0;
  if (count > 0) hit++;
  console.log(`${count > 0 ? "  ok " : "MISS "} L${String(at).padEnd(5)} ${name.padEnd(width)}  ${count}`);
}
console.log(`\n${hit}/${rows.length} functions in ${distFile} executed by ${testFile}`);
process.exit(hit === rows.length ? 0 : 1);
