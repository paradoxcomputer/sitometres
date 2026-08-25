// A password the tool was handed must not come back out of it.
//
// Two defects, both shipped, and the profile the README points a reader at
// types a password:
//
//   * the value a `type:` step carried was copied verbatim into stdout, the
//     live status line, the JSON report and the JUnit file — the artifact CI
//     publishes and the one a bug report gets pasted into. `secret: true` and
//     the `echoMode` backstop exist to close that, and the mask has to hide
//     the LENGTH too: a fixed-width mask that grew with the value would have
//     given away the only thing left to give away.
//   * `--help` tells users to prefer SITOMETRES_WALLET_PASSWORD over the flag
//     because a flag is visible to `ps` — and then the whole environment, that
//     variable included, was handed to the app under test and to everything it
//     shells out to. sitometres exists to crawl OTHER people's Basecamp
//     modules, including ones unpacked from a .lgx, so that was a credential
//     handed to untrusted code.
//
// Everything here runs on a fake inspector: no Basecamp, no sockets, no files.
import test from "node:test";
import assert from "node:assert/strict";

import { sanitiseEnv } from "../dist/app/lifecycle.js";
import { displayText, doType } from "../dist/runner/actions.js";
import { validateSpec } from "../dist/spec/schema.js";
import { Runner } from "../dist/runner/runner.js";
import { LogBuffer } from "../dist/logs/buffer.js";
import { toJson, toJUnit } from "../dist/report/machine.js";
import { status } from "../dist/report/status.js";

/** What a masked value is allowed to look like. Fixed width, by design. */
const MASK = '"••••••"';
/** Distinctive, and not a substring of anything else printed here. */
const SECRET = "correct-horse-battery-staple";

// --- the environment the app under test inherits -----------------------------

test("sanitiseEnv strips every SITOMETRES_ key and keeps everything else", () => {
  const before = {
    SITOMETRES_WALLET_PASSWORD: "hunter2",
    SITOMETRES_NO_STATUS: "1",
    SITOMETRES_: "empty tail",
    PATH: "/usr/bin:/bin",
    HOME: "/home/someone",
    // Not ours, and not a prefix match: a name that merely CONTAINS the word
    // belongs to somebody else's tool and must survive.
    MY_SITOMETRES_KEY: "not ours to remove",
    SITOMETRE_LEGACY: "one letter short of the prefix",
    LANG: "en_GB.UTF-8",
  };
  assert.deepEqual(sanitiseEnv(before), {
    PATH: "/usr/bin:/bin",
    HOME: "/home/someone",
    MY_SITOMETRES_KEY: "not ours to remove",
    SITOMETRE_LEGACY: "one letter short of the prefix",
    LANG: "en_GB.UTF-8",
  });
  assert.equal(
    sanitiseEnv(before).SITOMETRES_WALLET_PASSWORD,
    undefined,
    "the wallet password is the one --help tells people to put here",
  );
});

test("sanitiseEnv does not mutate the environment it was given", () => {
  // It is called with `process.env` in launch(), so a mutating implementation
  // would strip the password out of the tool's own process — and the wallet
  // unlock that reads it later happens after the launch.
  const env = { SITOMETRES_WALLET_PASSWORD: "hunter2", PATH: "/bin" };
  const out = sanitiseEnv(env);
  assert.notEqual(out, env, "a fresh object, not the same one filtered in place");
  assert.deepEqual(env, { SITOMETRES_WALLET_PASSWORD: "hunter2", PATH: "/bin" });
});

// --- how a typed value is allowed to be printed ------------------------------

test("displayText masks a secret and prints anything else as JSON", () => {
  assert.equal(displayText(SECRET, true), MASK);
  assert.equal(displayText(SECRET, false), '"correct-horse-battery-staple"');
  assert.equal(displayText(SECRET), '"correct-horse-battery-staple"', "unmarked is the default");
  // JSON.stringify, not quotes glued on: a value with a quote or a newline in
  // it lands in a JSON report and in XML, and hand-rolled quoting corrupts both.
  assert.equal(displayText('say "hi"\nthen leave'), '"say \\"hi\\"\\nthen leave"');
});

test("the mask does not reveal how long the value was", () => {
  // A per-character mask is the version that looks right and gives away the
  // password's length in every report — for a wallet password that is most of
  // what an attacker wanted to know.
  const short = displayText("a", true);
  const long = displayText("a".repeat(200), true);
  assert.equal(short, long, "two secrets 199 characters apart must print identically");
  assert.equal(short, MASK);
  assert.equal(displayText("", true), MASK, "and an empty one is not distinguishable either");
});

// --- typing into a field -----------------------------------------------------

/**
 * One editable field, plus an inspector that serves it.
 *
 * Shaped by what doType actually calls: getTree for the snapshot, getProperties
 * for `echoMode` and for the read-back, clickRef and callMethod to take focus,
 * setProperty to clear and as the fallback, sendKeys to type. `transform` is
 * the field's own idea of what it will accept — an input mask or a formatter —
 * which is what makes the read-back differ from what was sent.
 */
function fakeField({ echoMode = 0, transform = (s) => s } = {}) {
  const field = {
    id: "42",
    type: "TextField_QMLTYPE_84",
    objectName: "passwordField",
    text: "",
    visible: true,
    enabled: true,
  };
  const tree = {
    id: "1",
    type: "QQuickWidget",
    children: [{ id: "2", type: "Column_QMLTYPE_7", visible: true, children: [field] }],
  };
  const inspector = {
    async getTree() {
      return { tree };
    },
    async getProperties() {
      return { properties: [{ name: "echoMode", value: echoMode }, { name: "text", value: field.text }] };
    },
    async setProperty(_id, property, value) {
      if (property === "text") field.text = transform(String(value));
      return {};
    },
    async sendKeys(text) {
      field.text = transform(field.text + text);
      return { sent: text, target: field.type };
    },
    async clickRef() {
      return { clicked: true, x: 0, y: 0, widget: "QQuickWidget" };
    },
    async callMethod(_id, method) {
      return { invoked: method };
    },
  };
  return { field, inspector, ctx: { inspector, scopeId: null } };
}

const into = { objectName: "passwordField" };

test("a value typed with secret: true is nowhere in the line the step reports", async () => {
  const { ctx, field } = fakeField();
  const out = await doType(ctx, { into, text: SECRET, secret: true });
  assert.equal(out.detail, `typed ${MASK} into TextField_QMLTYPE_84 (passwordField)`);
  assert.ok(!out.detail.includes(SECRET), "this line reaches stdout, the JSON and the JUnit verbatim");
  assert.equal(out.targetId, "42");
  assert.equal(field.text, SECRET, "and the field really was typed into — the mask is not a no-op");
  assert.equal(out.check, undefined, "the read-back confirmed it, so there is nothing to qualify");
});

test("without it the same typing prints the value, so the mask is doing the work", async () => {
  // The other direction matters as much: a detail that never contains the text
  // would make every assertion above pass with displayText deleted.
  const { ctx } = fakeField();
  const out = await doType(ctx, { into, text: SECRET });
  assert.equal(out.detail, `typed "correct-horse-battery-staple" into TextField_QMLTYPE_84 (passwordField)`);
});

test("a field the app itself hides is masked even when the spec did not say secret", async () => {
  // The backstop. medusa_ui's wallet fields carry no objectName and the spec
  // author may not have thought about it; echoMode is the app saying, in its
  // own QML, that this value is not for display. 0 Normal, 1 NoEcho,
  // 2 Password, 3 PasswordEchoOnEdit.
  for (const echoMode of [1, 2, 3]) {
    const { ctx } = fakeField({ echoMode });
    const out = await doType(ctx, { into, text: SECRET });
    assert.equal(
      out.detail,
      `typed ${MASK} into TextField_QMLTYPE_84 (passwordField)`,
      `echoMode ${echoMode} hides the field on screen; printing it in a report is worse`,
    );
  }
  const { ctx } = fakeField({ echoMode: 0 });
  const out = await doType(ctx, { into, text: SECRET });
  assert.equal(
    out.detail,
    `typed "correct-horse-battery-staple" into TextField_QMLTYPE_84 (passwordField)`,
    "echoMode 0 is Normal — an ordinary field is not a secret",
  );
});

test("a field that mangles the value keeps BOTH strings out of the check it raises", async () => {
  // The second place the value appears. When the read-back does not contain
  // what was typed, doType raises an inconclusive check quoting both what it
  // sent and what the field now holds — and the field's contents are as secret
  // as the input. An inputMask or a formatter produces exactly this shape on a
  // field that took the password correctly.
  const { ctx, field } = fakeField({ transform: (s) => s.toUpperCase() });
  const out = await doType(ctx, { into, text: SECRET, secret: true });
  assert.equal(field.text, SECRET.toUpperCase());
  assert.equal(out.check.verdict, "inconclusive", "a formatter is not proof the typing failed");
  assert.equal(out.check.description, `the field took ${MASK}`);
  assert.ok(out.check.detail.startsWith(`after typing, its text is ${MASK} —`));
  for (const leak of [SECRET, SECRET.toUpperCase()]) {
    assert.ok(!out.check.detail.includes(leak), `the read-back leaked ${leak}`);
    assert.ok(!out.detail.includes(leak));
  }
});

// --- the whole reporting path ------------------------------------------------

/** A session the Runner can drive with no Basecamp anywhere. */
const session = (inspector) => ({ logs: new LogBuffer(), inspector });

/** Run one `type:` step through the real spec validation and the real Runner. */
async function runTypeStep(step, inspector) {
  const spec = validateSpec({ app: "medusa_ui", steps: [{ type: step }] });
  return new Runner({ session: session(inspector), spec, appName: "medusa_ui", logsUsable: false }).run();
}

test("the step's own name, built before the field resolves, is masked too", async () => {
  // describeAction runs on the spec alone — no snapshot, so echoMode cannot
  // help — and its result is the step name in the status line, the terminal
  // report, the JSON and the JUnit. Only the spec's `secret:` can mask it.
  const { inspector } = fakeField();
  const result = await runTypeStep({ into, text: SECRET, secret: true }, inspector);
  const step = result.steps[0];
  assert.equal(step.verdict, "pass");
  assert.equal(step.name, `type ${MASK}`);
  assert.equal(step.action, `typed ${MASK} into TextField_QMLTYPE_84 (passwordField)`);
  assert.ok(!JSON.stringify(result).includes(SECRET), "nothing anywhere in the result carries it");

  const plain = await runTypeStep({ into, text: SECRET }, fakeField().inspector);
  assert.equal(plain.steps[0].name, `type "correct-horse-battery-staple"`, "and without secret it is there");
});

test("neither the JSON report nor the JUnit file carries the value", async () => {
  // The mangling field, so the inconclusive check's description and detail —
  // which is what JUnit puts in <skipped message=…> — go through the writers
  // as well as the step name.
  const { inspector } = fakeField({ transform: (s) => s.toUpperCase() });
  const result = await runTypeStep({ into, text: SECRET, secret: true }, inspector);
  assert.equal(result.steps[0].verdict, "inconclusive");

  const report = {
    tool: "sitometres",
    version: "0.0.0-test",
    app: "medusa_ui",
    basecamp: "/nowhere",
    fidelity: { fidelity: "quiet", qtLogLines: 0, moduleLogLines: 0, summary: "no logs in this test" },
    verdict: result.verdict,
    durationMs: result.durationMs,
    steps: result.steps,
  };
  const json = toJson(report);
  const junit = toJUnit(report);
  // Positive controls, both of them. Asserting only that the secret is ABSENT
  // would pass with either writer returning "" — the absence has to be the
  // mask's doing, not the writer's. `junit.includes("skipped")` was the weaker
  // version of this: the attribute is emitted unconditionally, so it is true of
  // a report with no inconclusive step in it at all.
  assert.ok(junit.includes("••••••"), "the step really is in the file — otherwise this proves nothing");
  assert.ok(json.includes("••••••"), "and in the JSON, which has its own writer");
  assert.match(junit, /skipped="1"/, "and its inconclusive check came with it");
  for (const leak of [SECRET, SECRET.toUpperCase()]) {
    assert.ok(!json.includes(leak), `the JSON report leaked ${leak}`);
    assert.ok(!junit.includes(leak), `the JUnit file leaked ${leak}`);
  }
});

test("the live status line narrates the step without narrating the password", async () => {
  // The status line is the fourth copy, and the one nobody thinks about: it is
  // rewritten several times per step and, off a TTY, printed to stderr where CI
  // keeps it forever.
  const { inspector } = fakeField();
  const written = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.env.SITOMETRES_NO_STATUS = "1"; // force the non-TTY path, deterministically
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    status.start("Running", "starting");
    await runTypeStep({ into, text: SECRET, secret: true }, inspector);
    status.stop("Completed");
  } finally {
    process.stderr.write = realWrite;
    delete process.env.SITOMETRES_NO_STATUS;
  }
  const narration = written.join("");
  assert.ok(narration.includes(`step 1/1: type ${MASK}`), "the step really was narrated");
  assert.ok(!narration.includes(SECRET), "and the password was not");
});
