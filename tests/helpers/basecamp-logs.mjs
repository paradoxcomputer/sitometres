// Real Basecamp log lines, as the tests' input. See ../fixtures/basecamp-logs.
import fs from "node:fs";
import test from "node:test";

import { LogBuffer } from "../../dist/logs/buffer.js";
import { parseLine } from "../../dist/logs/classify.js";
import { expandLine } from "../../dist/logs/expand.js";

const DIR = new URL("../fixtures/basecamp-logs/", import.meta.url);

/** The raw lines of one fixture file, as Basecamp printed them. */
export function fixtureLines(name) {
  return fs.readFileSync(new URL(name, DIR), "utf8").split("\n").filter((l) => l.length > 0);
}

/**
 * A LogBuffer holding the fixture (or the lines given), each raw line
 * expanded first, which is what the live sources do.
 */
export function fixtureBuffer(nameOrLines) {
  const lines = typeof nameOrLines === "string" ? fixtureLines(nameOrLines) : nameOrLines;
  const buf = new LogBuffer();
  for (const raw of lines) for (const p of expandLine(raw)) buf.append(p.text, "stdout", p.viaUiHost);
  return buf;
}

/** The fixture, expanded and parsed. */
export function parsedFixture(nameOrLines) {
  return fixtureBuffer(nameOrLines).slice(0).map(parseLine);
}

/** The last line of a fixture: in the failure fixtures, the failure itself. */
function lastOf(name) {
  return fixtureLines(name).at(-1);
}

/**
 * The two dialects, each spelled with the lines that Basecamp version really
 * printed. A test that loops over these proves a verdict does not depend on
 * which Basecamp the run was against.
 *
 *   syncFail   the transport giving up on a synchronous call
 *   asyncFail  the transport giving up on an asynchronous one (unchanged)
 */
export const DIALECTS = [
  {
    name: "0.2.2",
    fake: "0.2.2",
    syncFail: lastOf("call-failed-sync.v022.log"),
    asyncFail: lastOf("call-failed-async.v022.log"),
    banner: fixtureLines("banner.v022.log")[0],
  },
  {
    name: "0.3.0",
    fake: "0.3",
    syncFail: lastOf("call-failed-sync.v030.log"),
    asyncFail: fixtureLines("call-failed-async.v030.log").find((l) => l.startsWith("RemoteLogosObject:")),
    banner: fixtureLines("banner.v030.log")[0],
  },
];

/** node:test's `test`, with the dialect in each test's name. */
export function dialectTest(dialect) {
  const wrap = (name, ...rest) => test(`${name} [Basecamp ${dialect.name}]`, ...rest);
  wrap.skip = (name, ...rest) => test.skip(`${name} [Basecamp ${dialect.name}]`, ...rest);
  return wrap;
}
