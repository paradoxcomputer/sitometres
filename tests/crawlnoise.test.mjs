// Telling a background poll from what a click actually caused — for ANY app.
//
// The crawl's only ignore list used to be two literal medusa method names
// compiled into smoke.ts. For every other author that broke the crawl's
// headline value: a poll landing inside the settle window makes an inert
// control report `ran`, so a dead control is indistinguishable from a live one.
import test from "node:test";
import assert from "node:assert/strict";

import { LogBuffer } from "../dist/logs/buffer.js";
import { parseLine } from "../dist/logs/classify.js";
import { classifyOutcome } from "../dist/runner/outcome.js";
import { NOISY_CALLS } from "../dist/commands/smoke.js";

const win = (lines) => {
  const b = new LogBuffer();
  for (const l of lines) b.append(l, "stdout");
  return b.slice(0).map(parseLine);
};

const call = (mod, method) => [
  `LogosAPIClient: invoking remote method "${mod}" "${method}" args_count: 0`,
  `[LogosObject] RemoteLogosObject::callMethod "${method}" args: 0`,
];

const outcome = (lines, over = {}) =>
  classifyOutcome({
    window: win(lines),
    newLabels: [],
    appName: "my_app",
    logsUsable: true,
    ignoreCalls: [],
    ...over,
  });

test("the tool ships no built-in ignore list naming anybody's app", () => {
  assert.deepEqual(
    NOISY_CALLS,
    [],
    "a tool for anyone's module must not carry one app's method names",
  );
});

test("an author's own poll can be ignored, so a dead control reads as dead", () => {
  const lines = call("my_core", "poll");
  assert.equal(outcome(lines).calls.length, 1, "without the ignore list the poll counts as activity");
  assert.equal(outcome(lines).outcome, "ran");

  const ignored = outcome(lines, { ignoreCalls: ["my_core.poll"] });
  assert.deepEqual(ignored.calls, []);
  assert.equal(ignored.outcome, "nothing", "an inert control must read as inert");
});

test("the ignore list accepts the same forms the assertion engine does", () => {
  const lines = call("my_core", "poll");
  for (const form of ["my_core.poll", "poll", "my_core.*"]) {
    assert.deepEqual(outcome(lines, { ignoreCalls: [form] }).calls, [], `${form} should match`);
  }
});

test("another module's method of the same name is NOT suppressed by default", () => {
  // `medusa_core.getJob` was hardcoded, and matching is by suffix, so it also
  // silenced a genuine timeout of any other module's getJob.
  const failing = [
    ...call("their_core", "getJob"),
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
  ];
  const r = outcome(failing);
  assert.equal(r.failedCalls.length, 1, "a real failure must not be hidden by a default list");
  assert.match(r.failedCalls[0], /getJob/);
});

test("a qrc: QML error from Basecamp itself is not blamed on the app", () => {
  // summarise() lacked this filter, so any internal error thrown while the dock
  // was built failed the open step and made the whole crawl exit 1.
  const theirs = outcome(["qrc:/qt/qml/Logos/Shell/SidebarPanel.qml:44: TypeError: boom"]);
  assert.deepEqual(theirs.errors, [], "Basecamp's own QML is not the app under test");

  const mine = outcome([
    "file:///tmp/x/plugins/my_app/qml/Main.qml:9: TypeError: boom",
  ]);
  assert.equal(mine.errors.length, 1, "the app's own errors still surface");
});
