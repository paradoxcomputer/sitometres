// Reading a command line.
//
// None of this could be tested before: parseArgs was module-local and cli.ts
// exported nothing, so every defect here was invisible to the suite. The worst
// of them was a data-safety bug — `sitometres --real-home medusa_ui` read
// "medusa_ui" as the VALUE of --real-home and then tested whatever app was in
// the current directory, against the developer's real $HOME.
import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, ArgError } from "../dist/cli.js";

const parse = (line) => parseArgs(line.split(" ").filter(Boolean));

/**
 * What main() actually reads after parsing: the verb, and the positional args
 * with the verb removed. Asserting on this rather than on parseArgs' internal
 * indices is the point — the bug this file exists for was dispatch and arity
 * disagreeing about which command was running.
 */
const shape = (line) => {
  const r = parse(line);
  return { verb: r.verb, rest: [r.command, ...r.positional].filter(Boolean), flags: r.flags };
};

test("a boolean flag does not swallow the app name", () => {
  for (const flag of ["--real-home", "--headed", "--no-setup", "--no-report", "--strict"]) {
    const { command, flags } = parse(`${flag} medusa_ui`);
    assert.equal(command, "medusa_ui", `${flag} must not consume the app name`);
    assert.equal(flags.get(flag.slice(2)), true);
  }
  // --debug is run-only, so it does not swallow a spec file either.
  const dbg = shape("run --debug spec.yaml");
  assert.equal(dbg.verb, "run");
  assert.deepEqual(dbg.rest, ["spec.yaml"]);
});

test("a boolean flag does not swallow a spec file", () => {
  const { verb, rest } = shape("run --headed spec.yaml");
  assert.equal(verb, "run");
  assert.deepEqual(rest, ["spec.yaml"], "run --headed spec.yaml used to report a missing spec");
});

test("value-taking flags still take their value", () => {
  const { flags, command } = parse("medusa_ui --limit 3 --settle 1500");
  assert.equal(command, "medusa_ui");
  assert.equal(flags.get("limit"), "3");
  assert.equal(flags.get("settle"), "1500");
});

test("--flag=value is accepted", () => {
  const { flags, command } = parse("--limit=5 medusa_ui");
  assert.equal(flags.get("limit"), "5");
  assert.equal(command, "medusa_ui", "an inline value must not eat the positional either");
});

test("a boolean flag rejects an inline value", () => {
  assert.throws(() => parse("--headed=yes"), (e) => e instanceof ArgError && /does not take a value/.test(e.message));
});

test("arity can differ per verb", () => {
  // --json is a boolean for inspect and a filename for run.
  assert.equal(parse("inspect medusa_ui --json").flags.get("json"), true);
  assert.equal(parse("run spec.yaml --json out.json").flags.get("json"), "out.json");
  assert.deepEqual(shape("inspect medusa_ui --json").rest, ["medusa_ui"]);
});

test("--attach takes a port, or nothing", () => {
  assert.equal(parse("run spec.yaml --attach 3768").flags.get("attach"), "3768");
  assert.equal(parse("run spec.yaml --attach").flags.get("attach"), true);
  // With nothing after it but another flag, it must not eat the flag.
  const withNext = parse("run spec.yaml --attach --headed");
  assert.equal(withNext.flags.get("attach"), true);
  assert.equal(withNext.flags.get("headed"), true);
});

test("a missing value is an error, not a silent true", () => {
  assert.throws(() => parse("medusa_ui --limit"), (e) => e instanceof ArgError && /needs a value/.test(e.message));
});

test("an unknown flag fails with a suggestion", () => {
  // `--jnuit results.xml` used to write nothing and exit 0.
  assert.throws(
    () => parse("run spec.yaml --jnuit out.xml"),
    (e) => e instanceof ArgError && /unknown flag --jnuit/.test(e.message) && /--junit/.test(e.hint),
  );
});

test("a flag that belongs to another verb says so", () => {
  assert.throws(
    () => parse("doctor --limit 3"),
    (e) => e instanceof ArgError && /does not mean anything for `doctor`/.test(e.message) && /smoke/.test(e.hint),
  );
});

// Advertised, accepted, and inert — the same defect already fixed for
// `smoke --debug`, one flag over. --breakpoint parsed and was stored, then the
// session dropped it because the debug context is built only when --debug is
// set, so the spec ran straight past the step the user asked to stop at with no
// diagnostic at all, while --help said "(requires --debug)".
test("--breakpoint without --debug is refused rather than ignored", () => {
  assert.throws(
    () => parse("run spec.yaml --breakpoint 3"),
    (e) => e instanceof ArgError && /--breakpoint needs --debug/.test(e.message) && /--debug --breakpoint/.test(e.hint),
  );
});

test("--breakpoint with --debug is fine", () => {
  const { flags } = parse("run spec.yaml --debug --breakpoint 3");
  assert.equal(flags.get("breakpoint"), "3");
});

test("--setup and --no-setup together are refused", () => {
  assert.throws(
    () => parse("smoke my_app --setup a.yaml --no-setup"),
    (e) => e instanceof ArgError && /contradict/.test(e.message),
  );
});

// Setup profiles were the crawl's alone, so a written spec had to duplicate the
// gate walkthrough and `init` could not scaffold past a gate at all.
test("every verb that opens an app accepts a setup profile", () => {
  for (const line of [
    "smoke my_app --setup p.yaml",
    "run spec.yaml --setup p.yaml",
    "inspect my_app --setup p.yaml",
    "init my_app --setup p.yaml",
  ]) {
    const { flags } = parse(line);
    assert.equal(flags.get("setup"), "p.yaml", line);
  }
  // doctor stages nothing, so it still refuses what it does not read.
  assert.throws(() => parse("doctor --setup p.yaml"), ArgError);
});

test("-- ends flag parsing", () => {
  const { verb, rest } = shape("run spec.yaml -- --not-a-flag");
  assert.equal(verb, "run");
  assert.deepEqual(rest, ["spec.yaml", "--not-a-flag"]);
});

test("--env is repeatable", () => {
  const { repeated } = parse("medusa_ui --env A=1 --env B=2");
  assert.deepEqual(repeated.get("env"), ["A=1", "B=2"]);
});

test("the crawl accepts CI outputs", () => {
  const { flags } = parse("medusa_ui --junit results.xml --json report.json --strict");
  assert.equal(flags.get("junit"), "results.xml");
  assert.equal(flags.get("json"), "report.json");
  assert.equal(flags.get("strict"), true);
});

// --- the verb, and flags written before it ----------------------------------

test("a value-taking flag before the verb does not hide the command", () => {
  // The verb scan stopped at the first bare token — but a value flag's VALUE is
  // a bare token, so `--port 9000 inspect` resolved arity against smoke.
  assert.equal(shape("--port 9000 inspect --json").verb, "inspect");
  assert.equal(shape("--app medusa_ui init --force").verb, "init");
  assert.equal(shape("--basecamp /opt/bc doctor --deep").verb, "doctor");
  assert.equal(shape("--app-dir /x run spec.yaml").verb, "run");
});

test("a flag before the verb is graded against the RIGHT verb", () => {
  // Each of these used to fail with a bogus error, because arity was resolved
  // against smoke while the command was something else.
  assert.equal(parse("--port 9000 inspect --json").flags.get("json"), true, "boolean for inspect");
  assert.equal(parse("--app-dir /x run spec.yaml --json out.json").flags.get("json"), "out.json");
  assert.doesNotThrow(() => parse("--app medusa_ui init --force"));
  assert.doesNotThrow(() => parse("--basecamp /opt/bc doctor --deep"));
});

test("and a smoke-only flag on run is still rejected, not silently dropped", () => {
  assert.throws(
    () => parse("--app-dir /x run spec.yaml --limit 3"),
    (e) => e instanceof ArgError && /--limit does not mean anything for `run`/.test(e.message),
  );
});

test("the app name survives a value flag written before the verb", () => {
  // The worst of the set: --json resolved as value-taking for smoke and ate the
  // app name, silently inspecting the current directory instead.
  const { verb, rest, flags } = shape("--port 9000 inspect --json medusa_ui");
  assert.equal(verb, "inspect");
  assert.equal(flags.get("json"), true, "--json is boolean for inspect");
  assert.deepEqual(rest, ["medusa_ui"], "the app name must not become --json's value");
});

test("an app whose name is a verb is still an app", () => {
  const { verb, rest } = shape("--app run");
  assert.equal(verb, "smoke", "--app takes a value, so its value is not the command");
  assert.deepEqual(rest, []);
});

// --- a command only accepts what it reads ------------------------------------

test("a command refuses flags it would silently ignore", () => {
  // `doctor --headed --port 9000 --real-home` used to run clean and do none of
  // it — in the one command a user reaches for when something is already wrong.
  for (const line of [
    "doctor --headed",
    "doctor --real-home",
    "doctor --timeout 5000",
    "inspect medusa_ui --debug",
    "inspect medusa_ui --strict",
    "init medusa_ui --breakpoint 3",
  ]) {
    assert.throws(
      () => parse(line),
      (e) => e instanceof ArgError && /does not mean anything for/.test(e.message),
      `${line} should be refused`,
    );
  }
});

test("and still accepts what it does read", () => {
  for (const line of [
    "doctor --deep",
    "doctor --set-basecamp /opt/bc",
    "doctor --basecamp /opt/bc",
    "run spec.yaml --debug --breakpoint 2",
    "run spec.yaml --strict --junit out.xml",
    "medusa_ui --strict --ignore-calls a,b",
    "inspect medusa_ui --hidden --json",
  ]) {
    assert.doesNotThrow(() => parse(line), `${line} should be accepted`);
  }
});

test("--debug on the crawl points at the command that has it", () => {
  assert.throws(
    () => parse("medusa_ui --debug"),
    (e) => e instanceof ArgError && /It is a flag for: run/.test(e.hint) && /no step boundaries/.test(e.hint),
  );
});
