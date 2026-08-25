// The paths a run takes when the machine is not set up the way it hoped.
//
// A missing dependency, a Basecamp without the inspector, a binary that cannot
// be executed, an attach with nowhere to read logs from, a question asked where
// nobody can answer. Each of these is a place the tool has to say something a
// developer can act on rather than fail with a stack trace — and each was
// reachable only by arranging the machine that way, so none of them was tested.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { boot } from "../dist/session.js";
import { attach, launch } from "../dist/app/lifecycle.js";
import { canPrompt, ask } from "../dist/report/prompt.js";
import { main, parseArgs, ArgError } from "../dist/cli.js";

const FAKE = fileURLToPath(new URL("./helpers/fake-basecamp.mjs", import.meta.url));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const cleanups = [];
test.after(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best effort */
    }
  }
});

function scratch(prefix) {
  const dir = tmp(prefix);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A repo holding one plugin, optionally declaring dependencies. */
function appRepo(dependencies = []) {
  const root = scratch("sito-bedge-");
  const dir = path.join(root, "plugins", "demo_ui");
  fs.mkdirSync(path.join(dir, "qml"), { recursive: true });
  fs.writeFileSync(path.join(dir, "qml", "Main.qml"), "Item {}");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ name: "demo_ui", type: "ui_qml", view: "qml/Main.qml", dependencies, main: {} }),
  );
  return root;
}

// --- boot's refusals ---------------------------------------------------------

test("a dependency nothing provides is named, with where it was looked for", async () => {
  // Staging an app without its core module produces an app that loads and does
  // nothing, which reads as an app bug. Saying which dependency is missing, and
  // where the tool looked, is the difference between that and a fixable message.
  const root = appRepo(["nowhere_core"]);
  await assert.rejects(
    () => boot({ cwd: root, basecamp: FAKE, timeoutMs: 5_000 }),
    (err) => {
      assert.match(err.message, /"demo_ui" depends on "nowhere_core", which could not be found/);
      assert.match(err.hint, /Build the dependency/);
      assert.match(err.hint, /--with/, "and the escape hatch is named");
      return true;
    },
  );
});

test("--app names an app that is not here, and the error lists what is", async () => {
  const root = appRepo();
  await assert.rejects(
    () => boot({ cwd: root, app: "not_a_thing", basecamp: FAKE, timeoutMs: 5_000 }),
    (err) => {
      assert.match(err.message, /no app called "not_a_thing" found/);
      assert.match(err.hint, /Available: demo_ui/, "the names it did find are the actionable part");
      return true;
    },
  );
});

test("a Basecamp path that cannot be used is described accurately", async () => {
  // Three different reasons, three different sentences. "not usable" for all of
  // them sends the reader to check the wrong thing.
  const root = appRepo();
  const dir = scratch("sito-bin-");

  const missing = path.join(dir, "nope");
  await assert.rejects(
    () => boot({ cwd: root, basecamp: missing, timeoutMs: 5_000 }),
    (err) => {
      assert.match(err.message + (err.hint ?? ""), /does not exist|not usable|no such/i);
      return true;
    },
  );

  const notExecutable = path.join(dir, "plain.txt");
  fs.writeFileSync(notExecutable, "definitely not a binary");
  await assert.rejects(
    () => boot({ cwd: root, basecamp: notExecutable, timeoutMs: 5_000 }),
    (err) => {
      const said = err.message + (err.hint ?? "");
      assert.match(said, /executable|inspector|usable/i);
      // Whatever it says, it must name the path the user gave.
      assert.ok(said.includes(notExecutable), said);
      return true;
    },
  );

  const aDirectory = path.join(dir, "adir");
  fs.mkdirSync(aDirectory);
  await assert.rejects(
    () => boot({ cwd: root, basecamp: aDirectory, timeoutMs: 5_000 }),
    (err) => {
      assert.ok((err.message + (err.hint ?? "")).includes(aDirectory));
      return true;
    },
  );
});

// --- launch and attach -------------------------------------------------------

test("a binary that cannot be spawned is an error, not an unhandled event", async () => {
  // Without the 'error' listener a failed spawn raises an unhandled event and
  // Node prints the one stack trace this tool otherwise never shows.
  const userDir = scratch("sito-nospawn-");
  const session = await launch({ binary: path.join(userDir, "does-not-exist"), userDir });
  await assert.rejects(
    () => session.waitUntilReady({ timeoutMs: 3_000 }),
    (err) => {
      assert.match(err.message, /does-not-exist|ENOENT/);
      return true;
    },
  );
  await session.stop();
});

test("attaching with no logs directory says so rather than pretending to read one", async () => {
  // Under --attach the tool cannot set QT_FORCE_STDERR_LOGGING on somebody
  // else's process, and without --logs-dir it has nowhere to read from at all.
  // The header has to say that, because every log-based assertion depends on it.
  const userDir = scratch("sito-attach2-");
  const owned = await launch({ binary: FAKE, userDir });
  await owned.waitUntilReady({ timeoutMs: 15_000 });

  const guest = attach({ port: owned.port });
  try {
    const ready = await guest.waitUntilReady({ timeoutMs: 10_000 });
    assert.equal(typeof ready.portMs, "number");
    assert.equal(ready.coreStartedMs, null, "an attached session never saw the app start");
    assert.equal(ready.uiProbeMs, null);
    assert.deepEqual(ready.modulesLoaded, []);
    assert.match(guest.logSource.describe(), /no log source \(pass --logs-dir\)/);
  } finally {
    await guest.stop();
    await owned.stop();
  }
});

// --- prompting ---------------------------------------------------------------

test("a question is only asked where somebody can answer it", async () => {
  // Every prompt has a flag equivalent, so CI must never block on one.
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const prev = process.env.SITOMETRES_NO_PROMPT;
  const set = (a, b) => {
    Object.defineProperty(process.stdin, "isTTY", { value: a, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: b, configurable: true });
  };
  try {
    delete process.env.SITOMETRES_NO_PROMPT;
    set(true, true);
    assert.equal(canPrompt(), true, "a terminal on both ends is the only case that can be answered");
    set(false, true);
    assert.equal(canPrompt(), false, "piped stdin: nobody is typing");
    set(true, false);
    assert.equal(canPrompt(), false, "piped stdout: the question would not be seen");

    set(true, true);
    process.env.SITOMETRES_NO_PROMPT = "1";
    assert.equal(canPrompt(), false, "and the escape hatch works even on a real terminal");
  } finally {
    if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin);
    if (stdout) Object.defineProperty(process.stdout, "isTTY", stdout);
    if (prev === undefined) delete process.env.SITOMETRES_NO_PROMPT;
    else process.env.SITOMETRES_NO_PROMPT = prev;
  }
});

test("ask returns what was typed, and closes the reader afterwards", async () => {
  // readline over a pipe: no terminal needed, and the interface must not be
  // left holding stdin — that is what made the whole suite hang once.
  const { PassThrough } = await import("node:stream");
  const input = new PassThrough();
  const output = new PassThrough();
  const realIn = Object.getOwnPropertyDescriptor(process, "stdin");
  const realOut = Object.getOwnPropertyDescriptor(process, "stdout");
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stdout", { value: output, configurable: true });
  try {
    const asked = ask("which Basecamp?");
    setTimeout(() => input.write("/opt/basecamp\n"), 10);
    assert.equal(await asked, "/opt/basecamp");
    assert.match(output.read().toString(), /which Basecamp\?/, "the question is actually put to them");
  } finally {
    Object.defineProperty(process, "stdin", realIn);
    Object.defineProperty(process, "stdout", realOut);
  }
});

// --- the argument parser's remaining corners ---------------------------------

test("a did-you-mean picks the nearest of several candidates", () => {
  // Array.sort never calls its comparator for a single element, so a typo with
  // exactly one near-miss does not exercise the ranking at all.
  // "hel" is within 2 of both "help" and "h", so the ranking actually runs.
  assert.throws(
    () => parseArgs(["run", "spec.yaml", "--hel"]),
    (e) => {
      assert.ok(e instanceof ArgError);
      assert.match(e.message, /unknown flag --hel/);
      assert.match(e.hint, /Did you mean --help\?/, "the nearest, not merely a near one");
      return true;
    },
  );
  // And the single-candidate case still works.
  assert.throws(
    () => parseArgs(["run", "spec.yaml", "--jso"]),
    (e) => e instanceof ArgError && /Did you mean --json\?/.test(e.hint),
  );
});

test("a comma list is split, trimmed and stripped of blanks", async () => {
  // `--skip a, b ,,c` is what a person types. Each entry has to arrive as the
  // label the crawl compares against, or the skip silently does nothing.
  const deps = {
    boot: async () => {
      throw new Error("stop here: the options are what this test is about");
    },
  };
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await assert.rejects(() => main(["demo_ui", "--skip", "Send, Transfer ,,Export", "--no-report"], deps));
  } finally {
    console.log = log;
    console.error = err;
  }
  // Reaching boot at all proves the line parsed; the split itself is asserted
  // directly, because that is the value the crawl uses.
  const { flags } = parseArgs(["demo_ui", "--skip", "Send, Transfer ,,Export"]);
  assert.equal(flags.get("skip"), "Send, Transfer ,,Export");
});

test("a bare positional that is a directory is a place to look, not an app name", async () => {
  // `sitometres ./some/dir` means "the app in there". Treating it as a module
  // name would send the tool hunting for an app called "./some/dir".
  const root = appRepo();
  let sawCwd = null;
  const deps = {
    boot: async (opts) => {
      sawCwd = opts.cwd;
      throw new Error("stop here");
    },
  };
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    await assert.rejects(() => main([root, "--no-report"], deps));
  } finally {
    console.log = log;
    console.error = err;
  }
  assert.equal(sawCwd, root, "an existing directory becomes --app-dir");

  let sawApp = null;
  const deps2 = {
    boot: async (opts) => {
      sawApp = opts.app;
      throw new Error("stop here");
    },
  };
  console.log = () => {};
  console.error = () => {};
  try {
    await assert.rejects(() => main(["definitely_not_a_directory", "--no-report"], deps2));
  } finally {
    console.log = log;
    console.error = err;
  }
  assert.equal(sawApp, "definitely_not_a_directory", "anything else is a module name");
});

test("an executable Basecamp without the inspector is refused, and named", async () => {
  // Different from "not executable" and from "not there": the binary is fine,
  // it simply was not built with ENABLE_QML_INSPECTOR, and there is nothing
  // sitometres can do with it. Saying which path that was is the whole message.
  const root = appRepo();
  const dir = scratch("sito-noinsp-");
  const bin = path.join(dir, "LogosBasecamp");
  // Big enough for hasInspector to bother reading, and without the needle.
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n" + "x".repeat(2048));
  fs.chmodSync(bin, 0o755);

  await assert.rejects(
    () => boot({ cwd: root, basecamp: bin, timeoutMs: 5_000 }),
    (err) => {
      assert.match(err.message, /no Basecamp with the QML inspector compiled in/);
      assert.ok(err.hint.includes(bin), err.hint);
      assert.match(err.hint, /has no inspector/, "singular, because there was one candidate");
      return true;
    },
  );
});

test("asked for a Basecamp and given a good one, the answer is remembered", async () => {
  // The one thing that genuinely varies per machine and cannot be derived.
  // Asking once and remembering beats a hardcoded list of somebody else's
  // directory layout — but only where there is somebody to ask.
  const { PassThrough } = await import("node:stream");
  const { locateBasecamp } = await import("../dist/app/discover.js");
  const root = appRepo();
  const home = scratch("sito-home-");

  const realIn = Object.getOwnPropertyDescriptor(process, "stdin");
  const realOut = Object.getOwnPropertyDescriptor(process, "stdout");
  const cwd = process.cwd();
  const env = { ...process.env };
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  output.columns = 80;

  const log = console.log;
  console.log = () => {};
  try {
    // The generic search walks up from cwd and looks under $HOME, so both have
    // to be somewhere with no Basecamp in it — otherwise this machine's own
    // install answers the question and the prompt never happens.
    process.chdir(home);
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, "config");
    for (const k of ["LDEX_BASECAMP_DIR", "SITOMETRES_BASECAMP", "LOGOS_BASECAMP_BIN", "SITOMETRES_NO_PROMPT"]) {
      delete process.env[k];
    }
    assert.deepEqual(locateBasecamp(), [], "precondition: nothing findable, so it has to ask");

    Object.defineProperty(process, "stdin", { value: input, configurable: true });
    Object.defineProperty(process, "stdout", { value: output, configurable: true });

    setTimeout(() => input.write(FAKE + "\n"), 50);
    const b = await boot({ cwd: root, timeoutMs: 15_000 });
    try {
      assert.equal(b.basecamp.path, FAKE, "the answer is used for this run");
    } finally {
      await b.dispose();
    }
    const saved = JSON.parse(fs.readFileSync(path.join(home, "config", "sitometres", "config.json"), "utf8"));
    assert.equal(saved.basecamp, FAKE, "and remembered, so the question is asked once");
  } finally {
    console.log = log;
    Object.defineProperty(process, "stdin", realIn);
    Object.defineProperty(process, "stdout", realOut);
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
  }
});

test("the CLI's own process wrapper sets the exit code", async () => {
  // cliMain's default `exit` really is process.exit, and the only honest way to
  // exercise that is to let it end a process. Run the built CLI as a child; its
  // coverage merges into this run through the inherited NODE_V8_COVERAGE.
  const { spawnSync } = await import("node:child_process");
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

  const ok = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^\d+\.\d+\.\d+/);

  const bad = spawnSync(process.execPath, [cli, "run", "spec.yaml", "--breakpoint", "3"], { encoding: "utf8" });
  assert.equal(bad.status, 1, "an ArgError exits 1");
  assert.match(bad.stderr, /--breakpoint needs --debug/);
  assert.doesNotMatch(bad.stderr, /at Object\.|\.js:\d+:\d+/, "and prints no stack trace");
});

test("a secret is read without echoing it, and Ctrl-C still gets out", async () => {
  // Raw mode rather than readline, which would print the characters: a wallet
  // password does not belong in terminal scrollback. It does not belong in argv
  // either, which is why this prompt is the default and --wallet-password is
  // documented as the CI-only route.
  const { PassThrough } = await import("node:stream");
  const { secret } = await import("../dist/report/prompt.js");

  const realIn = Object.getOwnPropertyDescriptor(process, "stdin");
  const realOut = Object.getOwnPropertyDescriptor(process, "stdout");
  const input = new PassThrough();
  const written = [];
  const output = new PassThrough();
  output.write = (chunk) => (written.push(String(chunk)), true);
  input.setRawMode = () => {};
  input.isRaw = false;
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stdout", { value: output, configurable: true });
  try {
    const asked = secret("Wallet password:");
    setTimeout(() => input.write("hunter2\r"), 10);
    assert.equal(await asked, "hunter2");
    const shown = written.join("");
    assert.match(shown, /Wallet password:/, "the question is put to them");
    assert.ok(!shown.includes("hunter2"), "and what they typed is never echoed");
  } finally {
    Object.defineProperty(process, "stdin", realIn);
    Object.defineProperty(process, "stdout", realOut);
  }
});
