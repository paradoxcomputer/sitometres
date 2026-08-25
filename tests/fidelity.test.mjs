// Whether this session's logs are worth reading at all.
//
// `assessFidelity` is the sole producer of `logsUsable`, the flag that decides
// whether every log-based assertion returns a verdict or INCONCLUSIVE — and
// until this file, nothing in the suite executed it. (tests/terminalreport
// calls it too, as a fixture for the run header; this is the file that pins its
// behaviour.) Both directions of a wrong answer are bugs, and both are silent:
//
//   too generous — a quiet session called "verbose" makes `no_errors:` and
//   `no_calls:` PASS against evidence nobody can see, which is the exact failure
//   mode CONTRIBUTING calls the worst one a runner has;
//   too mean — a verbose session called "quiet" turns every call and error
//   assertion INCONCLUSIVE and hands the developer a remedy for a problem they
//   do not have.
//
// The whole decision rests on one regex, QT_FAMILY, whose alternatives were
// pinned by nothing: dropping any one of them loses a family of measured
// evidence, and dropping its `^` anchor makes it match the module-host spdlog
// lines that arrive whether Qt logging is on or off — the reading of "verbose"
// on a session with no call evidence in it. Every line below is a real shape
// from ~/.local/share/Logos/LogosBasecampDev/logs.
import test from "node:test";
import assert from "node:assert/strict";

import { LogBuffer } from "../dist/logs/buffer.js";
import { assessFidelity } from "../dist/runner/fidelity.js";

const bufferOf = (lines, origin = "stdout") => {
  const b = new LogBuffer();
  for (const l of lines) b.append(l, origin);
  return b;
};

/** One measured line per prefix QT_FAMILY names, each matching only its own. */
const QT_FAMILIES = [
  ["LogosAPIClient:", 'LogosAPIClient: invoking remote method "medusa_core" "getWalletState" args_count: 0'],
  [
    "LogosAPIConsumer:",
    'LogosAPIConsumer: Calling invokeRemoteMethod: "medusa_core" "getWalletState" args_count: 0 timeout: 20000',
  ],
  ["[LogosObject]", '[LogosObject] RemoteLogosObject::callMethod "getWalletState" args: 0'],
  ["RemoteLogosObject", "RemoteLogosObject: callRemoteMethod failed or timed out: 1"],
  [
    "RemoteTransportConnection:",
    'RemoteTransportConnection: Requesting object: "package_manager" at "15:28:14.953"',
  ],
  ["qml: ", "qml: wallet ready"],
  ["qt.", 'qt.qpa.plugin: Could not load the Qt platform plugin "xcb" in ""'],
];

/** Lines a session emits whether or not qDebug reaches stderr: neither family. */
const SURVIVES_EITHER_WAY = [
  "Logos Core started successfully",
  'Module loaded: "medusa_core"',
  'Successfully loaded UI module: "tip_jar"',
];

/** The module hosts' spdlog output: same pipe, present in a quiet session too. */
const SPDLOG = [
  '[2026-08-17 12:00:00.123] [info] [package_manager] [LogosProviderObject] emitEvent: "packagesChanged"',
  '[2026-08-17 12:00:00.456] [info] [medusa_core] LogosAPIClient: invoking remote method "chat_manager" "getRooms" args_count: 0',
  "[2026-08-17 12:00:00.789] [warn] [medusa_core] wallet backend not reachable, retrying",
  '[2026-08-17 12:00:01.002] [debug] [package_manager] RemoteLogosObject::callMethod "listInstalled" args: 0',
];

test("each qt logging family on its own is enough to make a session verbose", () => {
  // Drop any one alternative from QT_FAMILY and exactly one of these stops
  // counting: the build still emits that family, the tool stops believing it.
  for (const [prefix, line] of QT_FAMILIES) {
    const r = assessFidelity(bufferOf([line]));
    assert.equal(r.fidelity, "verbose", `${prefix} is measured qt output`);
    assert.equal(r.qtLogLines, 1, `${prefix} must be counted as qt logging`);
    assert.equal(r.moduleLogLines, 0, `${prefix} is not a module host's spdlog line`);
  }
});

test("a startup trail of genuine qt lines is verbose, counted exactly, and carries no remedy", () => {
  const r = assessFidelity(bufferOf([...QT_FAMILIES.map(([, l]) => l), ...SURVIVES_EITHER_WAY]));
  assert.equal(r.fidelity, "verbose");
  assert.equal(r.qtLogLines, 7, "seven qt lines, and the three that are neither family are not counted as qt");
  assert.equal(r.moduleLogLines, 0, "nor are they structured module lines");
  assert.equal(
    Object.hasOwn(r, "remedy"),
    false,
    "there is nothing to remedy — telling a working session to relaunch with QT_FORCE_STDERR_LOGGING is noise",
  );
});

test("a session with no lines at all is quiet, and names the variable that brings the trail back", () => {
  const r = assessFidelity(new LogBuffer());
  assert.equal(r.fidelity, "quiet");
  assert.equal(r.qtLogLines, 0);
  assert.equal(r.moduleLogLines, 0);
  assert.equal(typeof r.remedy, "string", "a downgrade without a remedy is a dead end for the developer");
  assert.match(
    r.remedy,
    /QT_FORCE_STDERR_LOGGING=1/,
    "the remedy is the one setting that changes the answer; naming anything else is useless advice",
  );
});

test("module host spdlog lines are not evidence that qt logging is on", () => {
  // The case that matters. These arrive down the same pipe whether qDebug goes
  // to stderr or to journald, and one of them quotes an `invoking remote method`
  // trail from inside a module — so a QT_FAMILY that matched anywhere in the
  // line would report "verbose" for a session in which no call the UI makes is
  // visible, and `no_calls:` would PASS having read nothing.
  const r = assessFidelity(bufferOf(SPDLOG));
  assert.equal(r.qtLogLines, 0, "a marker inside a structured line is not qt logging");
  assert.equal(r.moduleLogLines, 4, "all four are counted as module logging");
  assert.equal(r.fidelity, "quiet");
  assert.match(r.remedy, /QT_FORCE_STDERR_LOGGING=1/);
});

test("a family marker that is not at the start of the line does not count", () => {
  const notAtStart = [
    // Wrapped by a module host: the marker is real, its position is not.
    '[2026-08-17 12:00:02.500] [debug] [medusa_core] LogosAPIClient: invoking remote method "medusa_core" "getBalance" args_count: 0',
    // An app's own stdout mentioning the trail it is waiting for.
    'tip_jar: waiting on LogosAPIClient: invoking remote method "medusa_core" "sendTip" args_count: 1',
    // Continuation text. Qt writes its category at column 0; indented is not it.
    '    RemoteTransportConnection: Requesting object: "package_manager" at "15:28:14.953"',
  ];
  const quiet = assessFidelity(bufferOf(notAtStart));
  assert.equal(quiet.qtLogLines, 0, "the ^ anchor is the whole difference here");
  assert.equal(quiet.moduleLogLines, 1, "only the structured one is a module line");
  assert.equal(quiet.fidelity, "quiet");

  const withOneReal = assessFidelity(
    bufferOf([...notAtStart, 'LogosAPIClient: invoking remote method "medusa_core" "getWalletState" args_count: 0']),
  );
  assert.equal(withOneReal.qtLogLines, 1, "exactly the line that starts with the marker, not the three that contain it");
  assert.equal(withOneReal.fidelity, "verbose");
});

test("one qt line among module chatter is enough — the threshold is one, not a proportion", () => {
  // Measured on the same binary: 5 lines with the variable unset, 242 with it
  // set. The quiet five are shapes like `Logos Core started successfully`, so
  // a single genuine qt line means the pipe is open; requiring a share of the
  // stream would report quiet for a short session that logged perfectly well.
  const lines = [];
  for (let i = 0; i < 4; i++) lines.push(...SPDLOG);
  lines.push('qml: tip sent');
  const r = assessFidelity(bufferOf(lines, "stderr"));
  assert.equal(r.fidelity, "verbose");
  assert.equal(r.qtLogLines, 1);
  assert.equal(r.moduleLogLines, 16);
  assert.equal(Object.hasOwn(r, "remedy"), false);
});
