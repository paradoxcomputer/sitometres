// Reaping what a run started: the process GROUP, and the dirs, and only ours.
//
// An orphaned Basecamp is the highest-consequence failure this tool has. It
// holds a user-dir, a wallet the run may have unlocked, and an unauthenticated
// inspector port on every interface, and src/app/lifecycle.ts records that an
// interrupted batch run really did leave some behind.
//
// The pid half of killOwned() — `process.kill(-pid, "SIGKILL")` — was covered
// by nothing in the default suite: its only source of pids was reapOnExit(),
// called from exactly one unexported place inside launch(), so exercising the
// path meant launching a real Basecamp, which put it behind the integration
// test that skips by default and has no CI job. Both functions are exported
// now, and these run on a fake Basecamp: a script that spawns a child of its
// own and sleeps, spawned detached so it leads its own group exactly as
// launch() spawns the real thing.
//
// Basecamp spawns a logos_host_qt per core module, and killing only the parent
// has historically left those behind holding the port. The child dying is
// therefore the point of the first test, and it is asserted on its own.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { killOwned, reapDirOnExit, reapOnExit, releaseDir } from "../dist/app/lifecycle.js";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sito-reaping-"));

/** A module host: it does nothing but stay alive, so only a signal ends it. */
const moduleHost = path.join(scratch, "fake-module-host.mjs");
// It also IGNORES SIGTERM, which is what makes SIGKILL load-bearing here.
// killOwned exists precisely because stop()'s polite SIGTERM-then-escalate is
// not available on an interrupted run: a plain node process dies on either
// signal, so a fake that took SIGTERM would leave `process.kill(-pid,
// "SIGKILL")` provable by nothing.
fs.writeFileSync(
  moduleHost,
  [
    'process.on("SIGTERM", () => {});',
    'process.on("SIGINT", () => {});',
    'process.on("SIGHUP", () => {});',
    "setTimeout(() => {}, 600_000);",
  ].join("\n") + "\n",
);

/**
 * The fake Basecamp. Spawns one child in its OWN process group — not detached,
 * which is what makes it reachable by a negative-pid signal and by nothing
 * else — then records the child's pid and sleeps.
 */
const basecamp = path.join(scratch, "fake-basecamp.mjs");
fs.writeFileSync(
  basecamp,
  [
    'import { spawn } from "node:child_process";',
    'import fs from "node:fs";',
    "const [host, pidFile] = process.argv.slice(2);",
    'const child = spawn(process.execPath, [host], { stdio: "ignore" });',
    "fs.writeFileSync(pidFile + `.part`, String(child.pid));",
    "fs.renameSync(pidFile + `.part`, pidFile);",
    "setTimeout(() => {}, 600_000);",
  ].join("\n"),
);

/** Every fake we started, so cleanup signals those and nothing else. */
const started = [];
let seq = 0;

async function fakeBasecamp() {
  const pidFile = path.join(scratch, `host-${++seq}.pid`);
  const proc = spawn(process.execPath, [basecamp, moduleHost, pidFile], {
    stdio: "ignore",
    // Own process group, the way launch() spawns Basecamp.
    detached: true,
  });
  proc.unref();
  const fake = { pid: proc.pid, childPid: null };
  started.push(fake);
  await until("the fake basecamp to report its module host", () => fs.existsSync(pidFile));
  fake.childPid = Number(fs.readFileSync(pidFile, "utf8"));
  await until("both fake processes to be up", () => alive(fake.pid) && alive(fake.childPid));
  return fake;
}

const PROC = fs.existsSync("/proc/self/stat");

/** `/proc/<pid>/stat` after the comm field: [state, ppid, pgrp, ...]. */
function procStat(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
}

function alive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // kill(pid, 0) still succeeds for a zombie — a process killed but not yet
  // reaped by its parent. A corpse is not an orphaned Basecamp.
  if (!PROC) return true;
  try {
    return procStat(pid)[0] !== "Z";
  } catch {
    return false;
  }
}

/** Poll rather than sleep, so a slow machine waits and a fast one does not. */
async function until(what, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) assert.fail(`${what}: still false after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function dirWithContents(name) {
  const root = path.join(scratch, name);
  fs.mkdirSync(path.join(root, "plugins", "tip_jar"), { recursive: true });
  fs.writeFileSync(path.join(root, "plugins", "tip_jar", "manifest.json"), "{}");
  return root;
}

after(() => {
  for (const fake of started) {
    for (const target of [-fake.pid, fake.childPid]) {
      if (!target) continue;
      try {
        process.kill(target, "SIGKILL");
      } catch {
        /* already reaped, which is the expected case */
      }
    }
  }
  started.length = 0;
  try {
    // Clears the module's own tracking too, so a failed test cannot leave a
    // pid or a path registered for the exit handler to act on afterwards.
    killOwned();
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("killOwned takes the module hosts down with the basecamp that spawned them", async () => {
  const fake = await fakeBasecamp();
  assert.notEqual(fake.childPid, fake.pid, "the fake really did spawn a second process");
  if (PROC) {
    assert.equal(
      Number(procStat(fake.childPid)[2]),
      fake.pid,
      "the module host is in the basecamp's group, which is the only reason -pid reaches it",
    );
  }

  reapOnExit(fake.pid);
  killOwned();

  await until("the basecamp to die", () => !alive(fake.pid));
  await until("the module host to die", () => !alive(fake.childPid));
  assert.equal(alive(fake.pid), false);
  assert.equal(
    alive(fake.childPid),
    false,
    "signalling pid instead of -pid leaves a logos_host_qt holding the inspector port",
  );
});

test("killOwned reaps every group it was given, not just the first", async () => {
  const [one, two] = [await fakeBasecamp(), await fakeBasecamp()];
  reapOnExit(one.pid);
  reapOnExit(two.pid);

  killOwned();

  await until("both basecamps and both module hosts to die", () =>
    [one, two].every((f) => !alive(f.pid) && !alive(f.childPid)),
  );
  // A `return` where the `continue` belongs, or a throw escaping the loop,
  // orphans everything after the first entry — one run of a batch reaped, the
  // rest still holding their user-dirs.
  assert.deepEqual(
    [one, two].map((f) => [alive(f.pid), alive(f.childPid)]),
    [
      [false, false],
      [false, false],
    ],
  );
});

test("killOwned removes the throwaway dirs, and releaseDir keeps one out of it", () => {
  // Reaping only the pids left the throwaway user-dir and $HOME behind: a few
  // MB per interrupted run, plus stale state a later --user-dir run inherits.
  const doomed = dirWithContents("throwaway-user-dir");
  const released = dirWithContents("cleaned-up-normally");
  reapDirOnExit(doomed);
  reapDirOnExit(released);
  // What stageUserDir().cleanup() and makeSandboxHome().cleanup() do once the
  // run has removed the directory itself: mkdtemp can hand the same name back
  // out afterwards, so a path we no longer own must not be deleted at exit.
  releaseDir(released);

  killOwned();

  assert.equal(fs.existsSync(doomed), false, "a registered throwaway dir is removed, contents and all");
  assert.equal(
    fs.readFileSync(path.join(released, "plugins", "tip_jar", "manifest.json"), "utf8"),
    "{}",
    "a released dir is untouched — releaseDir must actually un-register, not merely be called",
  );
  fs.rmSync(released, { recursive: true, force: true });
});

test("killOwned forgets what it reaped, so the second call deletes nothing", () => {
  // It really does run twice: the SIGINT handler calls it, then re-raises, and
  // process.on("exit") calls it again on the way out.
  //
  // This covers the ownedDirs half only. `owned.clear()` has no observable
  // consequence a test can safely produce — its point is that a pid recycled by
  // the OS must not be signalled by a later call, and manufacturing a recycled
  // pid means signalling a process this test did not start. Deleting
  // `owned.clear()` leaves this file green; say so rather than imply otherwise.
  const dir = dirWithContents("reused-path");
  reapDirOnExit(dir);
  killOwned();
  assert.equal(fs.existsSync(dir), false);

  // The name is free now, so anything may take it — including the next run.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "someone-elses.json"), "{}");
  killOwned();

  assert.equal(
    fs.readFileSync(path.join(dir, "someone-elses.json"), "utf8"),
    "{}",
    "without ownedDirs.clear() the exit handler deletes a path the run no longer owns",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a tracked process that is already gone does not stop the rest of the reaping", async () => {
  const fake = await fakeBasecamp();
  reapOnExit(fake.pid);
  const dir = dirWithContents("user-dir-behind-a-dead-pid");
  reapDirOnExit(dir);

  // Stop it the way a clean stop() would have, so killOwned meets a pid that
  // has already gone, and wait until the kernel has genuinely finished with it.
  process.kill(-fake.pid, "SIGKILL");
  await until("the fake to be gone before killOwned runs", () => !alive(fake.pid) && !alive(fake.childPid));

  // The dirs are removed after the pids, so an ESRCH allowed to escape here
  // costs the user-dir as well: nothing at all gets cleaned up.
  assert.doesNotThrow(() => killOwned());
  assert.equal(fs.existsSync(dir), false, "the throwaway dir is still removed after a dead pid");
});
