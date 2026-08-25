// What a run is allowed to touch on the developer's machine.
//
// Every test here failed before its fix. The first one is the important one:
// `--user-dir` recursively deleted the install it was pointed at, while the
// run header said it was staging into a throwaway directory.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stageUserDir } from "../dist/app/userdir.js";
import { killOwned } from "../dist/app/lifecycle.js";
import { isExecutableFile } from "../dist/app/discover.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** A user-dir that already looks like somebody's real Basecamp install. */
function populated() {
  const root = tmp("sito-userdir-");
  fs.mkdirSync(path.join(root, "plugins", "someone_elses_app"), { recursive: true });
  fs.writeFileSync(path.join(root, "plugins", "someone_elses_app", "manifest.json"), "{}");
  fs.mkdirSync(path.join(root, "modules", "their_core"), { recursive: true });
  fs.writeFileSync(path.join(root, "modules", "their_core", "manifest.json"), "{}");
  fs.mkdirSync(path.join(root, "module_data", "state"), { recursive: true });
  fs.writeFileSync(path.join(root, "module_data", "state", "db.sqlite"), "not a real db");
  return root;
}

/** A minimal DiscoveredApp, enough for stageUserDir to copy it. */
function app(name) {
  const src = tmp("sito-src-");
  fs.writeFileSync(path.join(src, "manifest.json"), JSON.stringify({ name, type: "ui_qml" }));
  return { manifest: { name }, slot: "plugins", form: "dir", artifact: src };
}

test("staging into a caller's user-dir deletes nothing that was already there", () => {
  const root = populated();
  const staged = stageUserDir([app("my_app")], { userDir: root });

  assert.ok(
    fs.existsSync(path.join(root, "plugins", "someone_elses_app", "manifest.json")),
    "another plugin must survive — this used to be recursively removed",
  );
  assert.ok(fs.existsSync(path.join(root, "modules", "their_core", "manifest.json")));
  assert.equal(
    fs.readFileSync(path.join(root, "module_data", "state", "db.sqlite"), "utf8"),
    "not a real db",
    "module data must survive",
  );
  assert.ok(fs.existsSync(path.join(root, "plugins", "my_app")), "the app under test is still staged");
  assert.deepEqual(
    staged.foreign.sort(),
    ["someone_elses_app", "their_core"],
    "what was already installed is reported, so the header can stop calling it throwaway",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("--reset-user-dir is the only thing that clears a caller's user-dir", () => {
  const root = populated();
  stageUserDir([app("my_app")], { userDir: root, reset: true });
  assert.ok(!fs.existsSync(path.join(root, "plugins", "someone_elses_app")), "an explicit reset does clear");
  assert.ok(fs.existsSync(path.join(root, "plugins", "my_app")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("a caller's user-dir is never removed on cleanup, only a temp one", () => {
  const root = populated();
  const staged = stageUserDir([app("my_app")], { userDir: root });
  staged.cleanup();
  assert.ok(fs.existsSync(root), "cleanup must not delete a directory we did not create");
  fs.rmSync(root, { recursive: true, force: true });

  const ephemeral = stageUserDir([app("my_app")], {});
  assert.equal(ephemeral.ephemeral, true);
  assert.deepEqual(ephemeral.foreign, [], "a fresh temp dir has nothing foreign in it");
  ephemeral.cleanup();
  assert.ok(!fs.existsSync(ephemeral.root), "a temp dir we made is ours to remove");
});

test("re-staging replaces the app's own directory but nothing else", () => {
  const root = populated();
  stageUserDir([app("my_app")], { userDir: root });
  fs.writeFileSync(path.join(root, "plugins", "my_app", "stale.txt"), "from a previous run");
  stageUserDir([app("my_app")], { userDir: root });
  assert.ok(
    !fs.existsSync(path.join(root, "plugins", "my_app", "stale.txt")),
    "the per-app destination is still cleared, which is all correct staging needed",
  );
  assert.ok(fs.existsSync(path.join(root, "plugins", "someone_elses_app")));
  fs.rmSync(root, { recursive: true, force: true });
});

// The header said only what SURVIVED — "<the others> (already installed, left
// alone)" — while staging deleted and rewrote the destination of the app under
// test and of every dependency, unconditionally. README.md and --help both
// promised, without qualification, that nothing already in a caller's
// --user-dir is deleted. Both halves have to be reported or the sentence is a
// lie by omission.
test("staging says which installed apps it replaced, not only which it left", () => {
  const root = populated();
  // Pre-install the app under test, as a real Basecamp install would have it.
  fs.mkdirSync(path.join(root, "plugins", "my_app"), { recursive: true });
  fs.writeFileSync(path.join(root, "plugins", "my_app", "released.txt"), "the copy that was installed");

  const staged = stageUserDir([app("my_app")], { userDir: root });

  assert.deepEqual(staged.replaced, ["my_app"], "the app whose directory was deleted and rewritten is named");
  assert.deepEqual(staged.foreign.sort(), ["someone_elses_app", "their_core"]);
  assert.ok(
    !fs.existsSync(path.join(root, "plugins", "my_app", "released.txt")),
    "and it really was replaced — the report has to match what happened",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("nothing is reported as replaced when there was nothing there", () => {
  const root = populated();
  const staged = stageUserDir([app("my_app")], { userDir: root });
  assert.deepEqual(staged.replaced, [], "staging into an empty slot replaced nothing");
  assert.deepEqual(staged.inPlace, []);
  fs.rmSync(root, { recursive: true, force: true });
});

// The destructive one. `installedApps()` discovers apps by scanning the
// Basecamp user-dir, setting `artifact` to the installed directory — so
// `sitometres <app> --user-dir <that install>` resolved the app to the exact
// path staging was about to remove. It removed it, and the copy then failed
// with ERR_FS_CP_EINVAL: the run destroyed an installed plugin and reported an
// error about copying a directory into itself.
test("an app discovered from the user-dir it is staged into is not deleted", () => {
  const root = populated();
  const dest = path.join(root, "plugins", "my_app");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "manifest.json"), JSON.stringify({ name: "my_app", type: "ui_qml" }));
  fs.writeFileSync(path.join(dest, "irreplaceable.txt"), "the only copy");

  const staged = stageUserDir(
    [{ manifest: { name: "my_app" }, slot: "plugins", form: "dir", artifact: dest }],
    { userDir: root },
  );

  assert.equal(
    fs.readFileSync(path.join(dest, "irreplaceable.txt"), "utf8"),
    "the only copy",
    "the source and the destination are the same directory; deleting it destroys the app",
  );
  assert.deepEqual(staged.inPlace, ["my_app"], "and the header says it was tested where it lies");
  assert.deepEqual(staged.replaced, [], "nothing was replaced, because nothing was copied");
  assert.ok(staged.staged.includes("my_app"), "it is still staged as far as Basecamp is concerned");
  fs.rmSync(root, { recursive: true, force: true });
});

test("an app built INSIDE its staging destination is refused, not deleted", () => {
  const root = populated();
  const dest = path.join(root, "plugins", "my_app");
  const built = path.join(dest, "result");
  fs.mkdirSync(built, { recursive: true });
  fs.writeFileSync(path.join(built, "manifest.json"), JSON.stringify({ name: "my_app", type: "ui_qml" }));

  assert.throws(
    () => stageUserDir([{ manifest: { name: "my_app" }, slot: "plugins", form: "dir", artifact: built }], { userDir: root }),
    /refusing to stage "my_app"/,
    "deleting the destination would delete the source, and there would be nothing left to copy",
  );
  assert.ok(fs.existsSync(path.join(built, "manifest.json")), "and it is still there after the refusal");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a Basecamp path is only accepted when it can actually be executed", () => {
  const dir = tmp("sito-bin-");
  const notExec = path.join(dir, "LogosBasecamp");
  fs.writeFileSync(notExec, "#!/bin/sh\ntrue\n", { mode: 0o644 });
  assert.equal(isExecutableFile(notExec), false, "a non-executable file reached spawn() and threw a raw stack");
  fs.chmodSync(notExec, 0o755);
  assert.equal(isExecutableFile(notExec), true);
  assert.equal(isExecutableFile(dir), false, "a directory is not a binary");
  assert.equal(isExecutableFile(path.join(dir, "nope")), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- which $HOME the run gets ------------------------------------------------

test("--wallet-password alone does NOT hand the app your real HOME", async () => {
  const { homeAndWallet } = await import("../dist/app/wallet.js");

  const passwordOnly = homeAndWallet(false, "hunter2");
  assert.equal(passwordOnly.realHome, undefined, "this used to select the real HOME silently");
  assert.equal(passwordOnly.wallet.choice, "fresh", "it unlocks the throwaway wallet");
  assert.equal(passwordOnly.wallet.password, "hunter2");

  const real = homeAndWallet(true, "hunter2");
  assert.equal(real.realHome, true);
  assert.equal(real.wallet.choice, "real");

  const realNoPassword = homeAndWallet(true, undefined);
  assert.equal(realNoPassword.realHome, true);
  assert.equal(realNoPassword.wallet.choice, "real");
  assert.equal(realNoPassword.wallet.password, undefined);

  assert.deepEqual(homeAndWallet(false, undefined), {}, "the default touches nothing");
});

test("a throwaway HOME is removed even when the process is killed", async () => {
  // Reaping only the PIDs left the sandbox HOME and user-dir behind — a few MB
  // per interrupted run, plus stale state a later --user-dir run would inherit.
  const { spawnSync } = await import("node:child_process");
  const dir = tmp("sito-reap-");
  const probe = path.join(dir, "where.txt");
  const script = path.join(dir, "probe.mjs");
  const sessionUrl = new URL("../dist/session.js", import.meta.url).href;
  fs.writeFileSync(
    script,
    [
      'import fs from "node:fs";',
      `import { makeSandboxHome } from ${JSON.stringify(sessionUrl)};`,
      "const s = makeSandboxHome();",
      `fs.writeFileSync(${JSON.stringify(probe)}, s.root);`,
      'process.kill(process.pid, "SIGINT");',
      "await new Promise((r) => setTimeout(r, 5000));",
    ].join("\n"),
  );
  spawnSync(process.execPath, [script], { stdio: "ignore", timeout: 20_000 });

  const root = fs.readFileSync(probe, "utf8");
  assert.ok(root.includes("sitometres-home-"), "the probe recorded the sandbox path");
  assert.ok(!fs.existsSync(root), `SIGINT must remove the throwaway HOME (${root} survived)`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- packaging ---------------------------------------------------------------

test("the reported version is the package's, with no second place to update", async () => {
  // src/version.ts used to be a literal copy, so `npm version patch` bumped
  // package.json and left --version and every machine report on the old number.
  const { VERSION } = await import("../dist/version.js");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
  assert.notEqual(VERSION, "0.0.0-unknown", "the manifest must actually be found from dist/");
});

test("every address the tool prints is one the manifest declares", () => {
  // --help once advertised a github.com URL that 404d, so this used to forbid
  // URLs outright. Now that the project has a home, the rule is narrower and
  // still closes the same hole: the only addresses --help may print are the
  // ones package.json commits to. An invented or stale URL fails here; that
  // those addresses actually resolve is checked at release time, by the
  // `the declared addresses resolve` step in .github/workflows/release.yml,
  // which is the only place it can be true.
  const cli = fs.readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const declared = new Set(
    [pkg.homepage, pkg.bugs?.url, pkg.repository?.url]
      .filter(Boolean)
      .map((u) => u.replace(/^git\+/, "").replace(/\.git$/, "").replace(/#.*$/, "")),
  );
  const urls = cli.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
  const undeclared = urls.filter((u) => !declared.has(u));
  assert.deepEqual(
    undeclared,
    [],
    `--help prints addresses package.json does not declare: ${undeclared.join(", ")}`,
  );
});

// --- a run puts a caller's user-dir back the way it found it ------------------

/** A user-dir with an app already installed in it, carrying a marker. */
function installed(root, name, marker, slot = "plugins") {
  const dir = path.join(root, slot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ name }));
  fs.writeFileSync(path.join(dir, "whose.txt"), marker);
  return dir;
}

test("what was installed is moved aside and put back when the run ends", () => {
  // `--user-dir <my real install>` means "test against my Basecamp", not
  // "replace the app in my Basecamp". It used to replace the installed copy of
  // the app under test, and every dependency, permanently and with no way back.
  const root = populated();
  const dest = installed(root, "my_app", "THE COPY I HAD INSTALLED");

  const staged = stageUserDir([app("my_app")], { userDir: root });
  assert.deepEqual(staged.replaced, ["my_app"]);
  assert.equal(staged.restores, true, "and it says it will put it back");
  assert.equal(
    fs.existsSync(path.join(dest, "whose.txt")),
    false,
    "during the run it really is the build under test that is installed",
  );

  staged.cleanup();

  assert.equal(
    fs.readFileSync(path.join(dest, "whose.txt"), "utf8"),
    "THE COPY I HAD INSTALLED",
    "and afterwards it is theirs again, byte for byte",
  );
  assert.deepEqual(
    fs.readdirSync(root).filter((n) => n.startsWith(".sitometres-restore")),
    [],
    "with nothing of ours left behind",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("an app that was not installed is removed again, not left behind", () => {
  // The other half of "temporarily": putting the directory back as it was found
  // means taking away what was added as well as restoring what was moved.
  const root = populated();
  const staged = stageUserDir([app("my_app")], { userDir: root });
  assert.ok(fs.existsSync(path.join(root, "plugins", "my_app")));
  assert.deepEqual(staged.replaced, [], "nothing was there to replace");
  assert.equal(staged.restores, true);

  staged.cleanup();

  assert.equal(fs.existsSync(path.join(root, "plugins", "my_app")), false, "and it is gone again");
  assert.ok(
    fs.existsSync(path.join(root, "plugins", "someone_elses_app")),
    "while everything that WAS installed is untouched",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("dependencies are restored too, not just the app under test", () => {
  const root = populated();
  const dep = installed(root, "my_core", "THEIR CORE MODULE", "modules");

  const core = app("my_core");
  core.slot = "modules";
  const staged = stageUserDir([app("my_app")], { userDir: root, extra: [core] });
  assert.deepEqual(staged.replaced, ["my_core"]);

  staged.cleanup();

  assert.equal(fs.readFileSync(path.join(dep, "whose.txt"), "utf8"), "THEIR CORE MODULE");
  assert.equal(fs.existsSync(path.join(root, "plugins", "my_app")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("--keep-staged leaves the build in place, and says so", () => {
  // Installing the build IS sometimes the point, so there is a way to ask.
  const root = populated();
  const dest = installed(root, "my_app", "THE COPY I HAD INSTALLED");

  const staged = stageUserDir([app("my_app")], { userDir: root, keepStaged: true });
  assert.equal(staged.restores, false);
  staged.cleanup();

  assert.equal(fs.existsSync(path.join(dest, "whose.txt")), false, "their copy is gone, as asked");
  assert.ok(fs.existsSync(path.join(dest, "manifest.json")), "and the staged build is what is installed");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a throwaway user-dir restores nothing, because the whole thing goes", () => {
  const staged = stageUserDir([app("my_app")], {});
  assert.equal(staged.restores, false);
  assert.equal(staged.ephemeral, true);
  staged.cleanup();
  assert.equal(fs.existsSync(staged.root), false);
});

test("an interrupted run still puts the installed copy back", () => {
  // The case worth ordering the teardown around: a Ctrl-C between staging and
  // cleanup would otherwise leave the developer without a plugin they had
  // installed, which is a worse outcome than the run simply failing.
  const root = populated();
  const dest = installed(root, "my_app", "THE COPY I HAD INSTALLED");

  stageUserDir([app("my_app")], { userDir: root });
  assert.equal(fs.existsSync(path.join(dest, "whose.txt")), false, "staged over, mid-run");

  // What the signal handlers and process.on("exit") call.
  killOwned();

  assert.equal(
    fs.readFileSync(path.join(dest, "whose.txt"), "utf8"),
    "THE COPY I HAD INSTALLED",
    "the restore rides the same teardown that reaps the processes",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("--reset-user-dir does not pretend it can be undone", () => {
  // It is documented as destructive and opt-in: it clears plugins, modules,
  // module data and logs. Offering to restore after that would be a promise
  // this cannot keep, so it does not make one.
  const root = populated();
  const staged = stageUserDir([app("my_app")], { userDir: root, reset: true });
  assert.equal(staged.restores, false);
  staged.cleanup();
  assert.equal(fs.existsSync(path.join(root, "plugins", "someone_elses_app")), false);
  fs.rmSync(root, { recursive: true, force: true });
});
