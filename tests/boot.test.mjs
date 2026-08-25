// Booting, launching, and the readiness gate — without a Basecamp.
//
// Every verb begins `await boot(opts)`, and that single line put `boot`,
// `launch`, `attach`, the readiness gate and the whole body of every command
// behind a real Qt binary. So none of it was tested, and it is where the
// expensive failures live: an interrupted run leaving an orphaned Basecamp
// holding an unlocked wallet and an open inspector port, an app that dies on
// startup reported as a bare connect timeout, a "ready" signal that fires
// before the UI exists.
//
// CONTRIBUTING says a test must not need a Basecamp. It does not say a test may
// not have something on the other end of the socket. tests/helpers/fake-basecamp.mjs
// is that: a Node script that speaks the inspector's newline-delimited JSON,
// emits log lines in the shapes src/logs/classify.ts measures, and can be told
// to misbehave in the specific ways a real one does.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { boot, selectApp, installedApps, appLabel, basecampUserDirs } from "../dist/session.js";
import { launch, attach } from "../dist/app/lifecycle.js";

const FAKE = fileURLToPath(new URL("./helpers/fake-basecamp.mjs", import.meta.url));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A repo holding one built ui_qml plugin, the shape discoverApps expects. */
function appRepo(name = "demo_ui", extra = {}) {
  const root = tmp("sito-repo-");
  const dir = path.join(root, "plugins", name);
  fs.mkdirSync(path.join(dir, "qml"), { recursive: true });
  fs.writeFileSync(path.join(dir, "qml", "Main.qml"), "import QtQuick\nItem {}\n");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ name, type: "ui_qml", view: "qml/Main.qml", dependencies: [], main: {}, ...extra }),
  );
  return { root, dir };
}

/** Everything a boot() needs pointed at fakes, plus a place to clean up. */
function bootOpts(root, over = {}) {
  return {
    cwd: root,
    basecamp: FAKE,
    // A throwaway HOME is the default and is what we want exercised, but the
    // fake must not inherit a HOME that does not exist.
    timeoutMs: 15_000,
    ...over,
  };
}

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

test("boot stages the app, launches, and comes back ready", async () => {
  const { root } = appRepo();
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

  const b = await boot(bootOpts(root, { env: { FAKE_MODULES: "demo_core" } }));
  try {
    assert.equal(b.app?.manifest.name, "demo_ui");
    assert.ok(b.basecamp, "it launched something rather than attaching");
    assert.equal(b.basecamp.path, FAKE);
    assert.ok(b.userDir, "a throwaway user-dir was staged");
    assert.equal(b.userDir.ephemeral, true);
    assert.ok(
      fs.existsSync(path.join(b.userDir.root, "plugins", "demo_ui", "manifest.json")),
      "and the app was actually copied into it",
    );
    assert.ok(b.sandboxHome, "a throwaway HOME, because --real-home was not asked for");
    assert.notEqual(b.sandboxHome, process.env.HOME);

    // The gate the whole launch exists to pass: the port answered AND the shell
    // rendered. A port alone opens ~1.4s in, well before modules have loaded.
    assert.equal(typeof b.ready.portMs, "number");
    assert.ok(b.ready.uiProbeMs !== null, "the UI probe must have succeeded, not merely timed out");

    // QT_FORCE_STDERR_LOGGING is set by launch(), so the Qt families arrive and
    // fidelity reads verbose. Without it a real Basecamp emits 5 lines a session.
    assert.equal(b.fidelity.fidelity, "verbose");
    assert.deepEqual(b.ready.modulesLoaded, ["demo_core"]);
  } finally {
    await b.dispose();
  }
});

test("the throwaway directories are gone once the run disposes", async () => {
  const { root } = appRepo();
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const b = await boot(bootOpts(root));
  const userDir = b.userDir.root;
  const home = b.sandboxHome;
  await b.dispose();
  assert.equal(fs.existsSync(userDir), false, "a temp user-dir we made is ours to remove");
  assert.equal(fs.existsSync(home), false, "and so is the throwaway HOME");
});

test("a session with no Qt logging reports quiet, and says how to get it back", async () => {
  // The other half of the fidelity decision, and the one that matters: on a
  // quiet session every log-based assertion must downgrade to INCONCLUSIVE
  // rather than pass against evidence nobody can see.
  const { root } = appRepo();
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const b = await boot(bootOpts(root, { env: { FAKE_QUIET: "1" } }));
  try {
    assert.equal(b.fidelity.fidelity, "quiet");
    assert.match(b.fidelity.remedy, /QT_FORCE_STDERR_LOGGING/);
  } finally {
    await b.dispose();
  }
});

test("an app that dies during startup is a readable error, not a connect timeout", async () => {
  // Racing the port against the process exit is what turns "Basecamp exited
  // during startup" into a real message with the log tail attached. Without it
  // the user waits out the full timeout and is then told the port never opened.
  const { root } = appRepo();
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      boot(
        bootOpts(root, {
          timeoutMs: 10_000,
          env: { FAKE_NO_LISTEN: "1", FAKE_EXIT_AFTER_MS: "150", FAKE_EXIT_CODE: "3" },
        }),
      ),
    (err) => {
      assert.match(err.message, /exited during startup/);
      assert.match(err.message, /code 3/, "the exit status is part of the diagnosis");
      assert.match(err.message, /Logos Core started successfully/, "and the log tail comes with it");
      return true;
    },
  );
});

test("launch reaps the whole process group, module hosts included", async () => {
  // Basecamp spawns a logos_host_qt per core module. Killing only the parent
  // has historically left those behind, holding a user-dir and an inspector
  // port — which is why the child is spawned detached and signalled by group.
  const userDir = tmp("sito-launch-");
  cleanups.push(() => fs.rmSync(userDir, { recursive: true, force: true }));
  const session = await launch({
    binary: FAKE,
    userDir,
    env: { FAKE_SPAWN_CHILD: "1" },
  });
  await session.waitUntilReady({ timeoutMs: 15_000 });

  const line = session.logs.slice(0).find((l) => /spawned module host pid=/.test(l.text));
  assert.ok(line, "the fake reported its child, so there is a group to reap");
  const childPid = Number(/pid=(\d+)/.exec(line.text)[1]);
  const parentPid = session.process.pid;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(alive(parentPid) && alive(childPid));

  await session.stop();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && (alive(parentPid) || alive(childPid))) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(alive(parentPid), false, "the Basecamp we started is gone");
  assert.equal(alive(childPid), false, "and so is its module host — the whole point of the process group");
});

test("attach drives an inspector it did not start, and does not kill it on stop", async () => {
  // The other mode: someone else's process. sitometres must not reap it, and
  // it cannot set QT_FORCE_STDERR_LOGGING on it either — which is why attach
  // sessions are the canonical quiet ones.
  const userDir = tmp("sito-attach-");
  cleanups.push(() => fs.rmSync(userDir, { recursive: true, force: true }));
  const owned = await launch({ binary: FAKE, userDir });
  await owned.waitUntilReady({ timeoutMs: 15_000 });

  const guest = await attach({ port: owned.port });
  try {
    const tree = await guest.inspector.getTree();
    assert.equal(tree.tree.id, "root", "it really is talking to the running instance");
    assert.equal(guest.mode, "attached");
  } finally {
    await guest.stop();
  }

  assert.ok(owned.process.exitCode === null, "stopping an attached session must not kill somebody else's app");
  await owned.stop();
});

test("a sibling checkout never replaces the app you pointed at", async () => {
  // Found by the suite itself, as a flake: `collectWithDependencies` sweeps
  // `path.dirname(cwd)` for dependencies, and `discoverApps` scans one level of
  // children below its root — so the sweep reaches every SIBLING directory. A
  // sibling holding a plugin of the same name (a fork, a second checkout, a copy
  // in /tmp) won on `builtAt` alone and was staged INSTEAD of the build the user
  // asked for, reported only as a different `built` line in the header. That
  // contradicts the rule boot states three lines above it: "a developer testing
  // from their repo means their build".
  const parent = tmp("sito-siblings-");
  cleanups.push(() => fs.rmSync(parent, { recursive: true, force: true }));

  const mine = path.join(parent, "mine");
  const theirs = path.join(parent, "theirs");
  for (const [root, marker] of [[mine, "MINE"], [theirs, "THEIRS"]]) {
    const dir = path.join(root, "plugins", "demo_ui");
    fs.mkdirSync(path.join(dir, "qml"), { recursive: true });
    fs.writeFileSync(path.join(dir, "qml", "Main.qml"), "Item {}");
    fs.writeFileSync(path.join(dir, "whose.txt"), marker);
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ name: "demo_ui", type: "ui_qml", view: "qml/Main.qml", dependencies: [], main: {} }),
    );
  }
  // The sibling is the NEWER build, which is exactly how it used to win.
  const later = Date.now() / 1000 + 60;
  fs.utimesSync(path.join(theirs, "plugins", "demo_ui"), later, later);
  fs.utimesSync(path.join(theirs, "plugins", "demo_ui", "manifest.json"), later, later);

  const b = await boot(bootOpts(mine));
  try {
    assert.equal(b.app.artifact, path.join(mine, "plugins", "demo_ui"), "the app is the one in the named directory");
    assert.equal(
      fs.readFileSync(path.join(b.userDir.root, "plugins", "demo_ui", "whose.txt"), "utf8"),
      "MINE",
      "and it is that build that got staged, not the newer sibling",
    );
  } finally {
    await b.dispose();
  }
});

// --- the pure parts of session.ts -------------------------------------------

test("selectApp needs something with a UI, and says so when there is none", () => {
  // `slot` is what decides it, not `type`: Basecamp loads plugins/ as UI and
  // modules/ as headless, and that is the distinction a user can act on.
  const ui = { slot: "plugins", manifest: { name: "demo_ui", type: "ui_qml", dependencies: [] }, origin: "plugins/demo_ui" };
  const core = { slot: "modules", manifest: { name: "demo_core", type: "core", dependencies: [] }, origin: "modules/demo_core" };

  assert.equal(selectApp([ui]).manifest.name, "demo_ui");
  assert.equal(selectApp([ui, core], "demo_ui").manifest.name, "demo_ui");

  // A lone core module is a pointed error rather than a confusing empty run:
  // there is nothing to click.
  assert.throws(() => selectApp([core]), /core module with no UI/);
  assert.throws(() => selectApp([]), /no Logos app found/);
  assert.throws(() => selectApp([ui, core], "not_here"), /no app called "not_here"/);
  // Naming a core module explicitly used to skip the guard, burn the whole open
  // budget waiting for a dock that can never exist, and then fail with a
  // staging message that was also wrong.
  assert.throws(() => selectApp([ui, core], "demo_core"), /core module with no UI/);
  // Two UI apps and no --app is a question, not a guess.
  const second = { slot: "plugins", manifest: { name: "other_ui", type: "ui_qml", dependencies: [] }, origin: "plugins/other_ui" };
  assert.throws(() => selectApp([ui, second]), /found 2 UI apps/);
});

test("appLabel prefers what the sidebar shows, and falls back to the module name", () => {
  assert.equal(appLabel({ manifest: { name: "medusa_ui", display_name: "Medusa", dependencies: [] } }), "Medusa");
  assert.equal(appLabel({ manifest: { name: "medusa_ui", dependencies: [] } }), "medusa_ui");
});

test("installedApps looks where Basecamp actually keeps them", () => {
  // It scans basecampUserDirs(). Point $LOGOS_USER_DIR at a fixture so the
  // answer is about the code and not about what this machine happens to have.
  const root = tmp("sito-install-");
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "plugins", "installed_ui");
  fs.mkdirSync(path.join(dir, "qml"), { recursive: true });
  fs.writeFileSync(path.join(dir, "qml", "Main.qml"), "Item {}");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ name: "installed_ui", type: "ui_qml", view: "qml/Main.qml", dependencies: [], main: {} }),
  );

  const prev = process.env.LOGOS_USER_DIR;
  process.env.LOGOS_USER_DIR = root;
  try {
    assert.equal(basecampUserDirs()[0], root, "the override is honoured");
    const found = installedApps().map((a) => a.manifest.name);
    assert.ok(found.includes("installed_ui"), `expected installed_ui among ${JSON.stringify(found)}`);
  } finally {
    if (prev === undefined) delete process.env.LOGOS_USER_DIR;
    else process.env.LOGOS_USER_DIR = prev;
  }
});

test("a Basecamp that will not go quietly is escalated to SIGKILL, and says so", async () => {
  // stop() sends SIGTERM to the group and waits, then escalates. The escalation
  // exists because a hung Qt GUI thread does not answer signals politely, and
  // `forced` is how the caller learns the difference between a clean shutdown
  // and one it had to take by force.
  const userDir = tmp("sito-forced-");
  cleanups.push(() => fs.rmSync(userDir, { recursive: true, force: true }));
  const session = await launch({
    binary: FAKE,
    userDir,
    env: { FAKE_IGNORE_SIGTERM: "1" },
    // A short grace, so this exercises the escalation instead of waiting out
    // the ten-second default. The branch is the point, not the clock.
    stopGraceMs: 1_000,
  });
  await session.waitUntilReady({ timeoutMs: 15_000 });

  const summary = await session.stop();
  assert.equal(summary.forced, true, "SIGTERM was ignored, so it had to escalate");
  assert.equal(summary.signal, "SIGKILL");
});

test("a stopped session lets the process exit", async () => {
  // Detaching the log pump's listener only PAUSES the stream: the pipe handle
  // stays open and referenced, so the event loop never empties. The CLI never
  // noticed because it ends with process.exit(), but README advertises boot()
  // and dispose() as a library, and an embedder's process would simply refuse to
  // exit after a run. Measured before the fix: this file took 11s to do 3s of
  // work, entirely in teardown.
  const { root } = appRepo();
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

  const before = process.getActiveResourcesInfo().filter((h) => h === "PipeWrap").length;
  const b = await boot(bootOpts(root));
  assert.ok(
    process.getActiveResourcesInfo().filter((h) => h === "PipeWrap").length > before,
    "the child's stdout and stderr are being pumped while the session is up",
  );
  await b.dispose();
  assert.equal(
    process.getActiveResourcesInfo().filter((h) => h === "PipeWrap").length,
    before,
    "and released again afterwards — otherwise nothing that embeds this can ever exit",
  );
});
