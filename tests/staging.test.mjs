// Which copy of each app a run stages, and the hash that proves it.
//
// ST1: a dependency that existed both as a local build and as an installed
// copy of the same version was taken from the install whenever the install's
// mtime was newer. A nix-built `result/*.lgx` always reads the epoch, so the
// install always won, and an audit's first green runs were about the wrong
// bytes. ST2: nothing a user read could have caught it. The header named the
// app and no dependency, and printed no hash.
//
// Every test here builds its own world: a fake $HOME, a fake Basecamp install
// under $LOGOS_USER_DIR, and a parent directory holding exactly the siblings
// the test wants the dependency sweep to see. Nothing reads this machine's
// real install.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { discoverCopies, mainEntryOf } from "../dist/app/discover.js";
import { displayArtifact, predictStaged, recordStaged } from "../dist/app/fingerprint.js";
import { chooseVariant, hostVariant, stageUserDir } from "../dist/app/userdir.js";
import { planStaging, stagingNotes } from "../dist/session.js";
import { formatStagedLines } from "../dist/report/terminal.js";

const VARIANT = hostVariant();
const HOUR = 3_600_000;

const made = [];
const tmp = (p) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  made.push(dir);
  return dir;
};
test.after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * A world with nothing installed but what a test puts there.
 *
 * `parent` is the directory whose children the dependency sweep reaches;
 * `repo` is where the run is started; `install` is $LOGOS_USER_DIR.
 */
function world() {
  const parent = tmp("sito-stage-");
  const home = path.join(parent, "home");
  const install = path.join(parent, "install");
  const repo = path.join(parent, "repo");
  for (const d of [home, install, repo]) fs.mkdirSync(d, { recursive: true });
  return { parent, home, install, repo };
}

/** Run fn with $HOME and $LOGOS_USER_DIR pointed at the world. */
function inWorld(w, fn) {
  const prev = { HOME: process.env.HOME, LOGOS_USER_DIR: process.env.LOGOS_USER_DIR };
  process.env.HOME = w.home;
  process.env.LOGOS_USER_DIR = w.install;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};

/** Set a file's, or every file under a directory's, mtime. */
function touch(p, ms) {
  const t = ms / 1000;
  if (fs.statSync(p).isDirectory()) {
    for (const e of fs.readdirSync(p, { recursive: true })) fs.utimesSync(path.join(p, e), t, t);
  }
  fs.utimesSync(p, t, t);
}

/** A built pure-QML UI plugin at `<root>/plugins/<name>`. */
function uiPlugin(root, name, { deps = [], version = "1.0.0" } = {}) {
  const dir = path.join(root, "plugins", name);
  write(path.join(dir, "qml", "Main.qml"), `import QtQuick\nItem { objectName: "${name}" }\n`);
  write(
    path.join(dir, "manifest.json"),
    JSON.stringify({ name, version, type: "ui_qml", view: "qml/Main.qml", dependencies: deps, main: {} }),
  );
  return dir;
}

/** A built core module at `<root>/modules/<name>`, its library holding `lib`. */
function coreDir(root, name, version, lib = `${name} ${version} from ${root}`) {
  const dir = path.join(root, "modules", name);
  write(path.join(dir, `${name}_plugin.so`), lib);
  write(
    path.join(dir, "manifest.json"),
    JSON.stringify({ name, version, type: "core", dependencies: [], main: { [VARIANT]: `${name}_plugin.so` } }),
  );
  return dir;
}

/** A tar.gz, the way a .lgx is one. */
function lgx(entries) {
  const blocks = [];
  for (const [name, content] of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(Buffer.byteLength(content).toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512);
    body.write(content);
    blocks.push(header, body);
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** A packaged core module, with its library under the host's variant. */
function coreLgx(file, name, version, lib = `${name} ${version} packaged`) {
  const manifest = { name, version, type: "core", dependencies: [], main: { [VARIANT]: `${name}_plugin.so` } };
  write(file, lgx([
    ["manifest.json", JSON.stringify(manifest)],
    [`variants/${VARIANT}/${name}_plugin.so`, lib],
  ]));
  return file;
}

/** A nix out-link: `<root>/<link>` -> a store directory holding `files`. */
function outLink(w, link, files) {
  const store = path.join(w.parent, "store", `${Math.random().toString(36).slice(2)}-out`);
  for (const [name, body] of Object.entries(files)) write(path.join(store, name), body);
  const at = path.join(w.repo, link);
  fs.symlinkSync(store, at);
  return { store, at };
}

const chosen = (plan, name) => plan.staged.find((s) => s.manifest.name === name);
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// --- ST1: which copy is staged ---------------------------------------------

test("provenance comes from the path: under a Basecamp user-dir is installed, anything else is local", () => {
  const w = world();
  coreDir(w.install, "demo_core", "0.5.0");
  coreDir(w.repo, "demo_core", "0.5.0");
  inWorld(w, () => {
    assert.deepEqual(discoverCopies(w.install).map((c) => c.provenance), ["installed"]);
    assert.deepEqual(discoverCopies(w.repo).map((c) => c.provenance), ["local"]);
    // A symlink into the install is still the install: the REAL path decides.
    const alias = path.join(w.parent, "alias");
    fs.symlinkSync(w.install, alias);
    assert.deepEqual(discoverCopies(alias).map((c) => c.provenance), ["installed"]);
  });
});

test("a nix-built dependency beats a newer installed copy of the same version (ST1)", () => {
  // The exact shape of the audit's first runs: result/ holds a fresh build of
  // the core, every store mtime is the epoch, and the install was touched now.
  const w = world();
  uiPlugin(w.repo, "demo_ui", { deps: ["demo_core"] });
  const { store } = outLink(w, "result", {});
  const built = coreLgx(path.join(store, "demo_core.lgx"), "demo_core", "0.5.0", "FRESH BUILD");
  touch(built, 1);
  coreDir(w.install, "demo_core", "0.5.0", "INSTALLED");
  touch(path.join(w.install, "modules", "demo_core"), Date.now());

  const plan = inWorld(w, () => planStaging({ cwd: w.repo }));
  const core = chosen(plan, "demo_core");
  assert.equal(core.artifact, path.join(w.repo, "result", "demo_core.lgx"), "the local .lgx is staged");
  assert.equal(core.provenance, "local");
  const decision = plan.decisions.find((d) => d.name === "demo_core");
  assert.deepEqual(
    decision.passedOver.map((p) => [p.copy.provenance, p.reason]),
    [["installed", "installed"]],
    "the install lost because it is the install, not because of any clock",
  );
});

test("an unpacked sibling build beats an installed copy touched later (ST1)", () => {
  const w = world();
  uiPlugin(w.repo, "demo_ui", { deps: ["core_x"] });
  const sibling = path.join(w.parent, "core-repo");
  coreDir(sibling, "core_x", "1.2.0", "SIBLING");
  touch(path.join(sibling, "modules", "core_x"), Date.now() - HOUR);
  coreDir(w.install, "core_x", "1.2.0", "INSTALLED");
  touch(path.join(w.install, "modules", "core_x"), Date.now() - 60_000);

  const plan = inWorld(w, () => planStaging({ cwd: w.repo }));
  assert.equal(chosen(plan, "core_x").artifact, path.join(sibling, "modules", "core_x"));
  assert.equal(chosen(plan, "core_x").provenance, "local");
});

test("a higher installed version still wins, and the header says a local copy lost (ST1)", () => {
  const w = world();
  uiPlugin(w.repo, "demo_ui", { deps: ["demo_core"] });
  const local = coreDir(w.repo, "demo_core", "0.4.0");
  coreDir(w.install, "demo_core", "0.5.0");

  const plan = inWorld(w, () => planStaging({ cwd: w.repo }));
  assert.equal(chosen(plan, "demo_core").manifest.version, "0.5.0");
  assert.equal(chosen(plan, "demo_core").provenance, "installed");
  const notes = stagingNotes(plan);
  assert.equal(notes.length, 1, JSON.stringify(notes));
  assert.match(notes[0], /^demo_core: passed over the local 0\.4\.0 at /);
  assert.ok(notes[0].includes(displayArtifact(local)), "naming its path");
  assert.match(notes[0], /for a lower version than the installed 0\.5\.0/);
});

test("an incomplete local copy loses to a complete installed one (ST1)", () => {
  const w = world();
  uiPlugin(w.repo, "demo_ui", { deps: ["demo_core"] });
  // A manifest-only stub: it promises a library the build has not produced.
  write(
    path.join(w.repo, "modules", "demo_core", "manifest.json"),
    JSON.stringify({ name: "demo_core", version: "0.5.0", type: "core", dependencies: [], main: { [VARIANT]: "demo_core_plugin.so" } }),
  );
  coreDir(w.install, "demo_core", "0.5.0");
  const plan = inWorld(w, () => planStaging({ cwd: w.repo }));
  assert.equal(chosen(plan, "demo_core").provenance, "installed");
  assert.equal(chosen(plan, "demo_core").incomplete, undefined);
  assert.deepEqual(
    plan.decisions.find((d) => d.name === "demo_core").passedOver.map((p) => p.reason),
    ["incomplete"],
  );
});

test("a fresh nix build is dated by its out-link, and beats an hour-old copy found beside it (ST1)", () => {
  const w = world();
  uiPlugin(w.repo, "demo_ui", { deps: ["demo_core"] });
  const dir = coreDir(w.repo, "demo_core", "0.5.0", "AN HOUR OLD");
  touch(dir, Date.now() - HOUR);
  const { store, at } = outLink(w, "result", {});
  touch(coreLgx(path.join(store, "demo_core.lgx"), "demo_core", "0.5.0", "JUST BUILT"), 1);
  const linkedAt = Date.now() - 5 * 60_000;
  fs.lutimesSync(at, linkedAt / 1000, linkedAt / 1000);

  const plan = inWorld(w, () => planStaging({ cwd: w.repo }));
  const core = chosen(plan, "demo_core");
  assert.equal(core.form, "lgx", "the out-link's build won");
  assert.ok(Math.abs(core.builtAt - linkedAt) < 1000, `dated by the link: ${core.builtAt} vs ${linkedAt}`);
  assert.deepEqual(plan.decisions.find((d) => d.name === "demo_core").passedOver.map((p) => p.reason), ["older"]);

  // And the header shows its age in minutes, not as unknown.
  const record = predictStaged(core, VARIANT);
  const [line] = formatStagedLines([record], [], false);
  assert.match(line, /\(lgx, 5 min ago\)/, line);
});

test("two local copies whose times cannot be compared: the first found is kept, and that is said (ST1)", () => {
  const w = world();
  uiPlugin(w.repo, "app_x", { version: "2.0.0" });
  touch(path.join(w.repo, "plugins", "app_x"), Date.now());
  // An .lgx of the same version, epoch-dated, with no out-link to date it.
  const pkg = write(
    path.join(w.repo, "app_x.lgx"),
    lgx([
      ["manifest.json", JSON.stringify({ name: "app_x", version: "2.0.0", type: "ui_qml", view: "qml/Main.qml", dependencies: [], main: {} })],
      [`variants/${VARIANT}/qml/Main.qml`, "Item {}"],
    ]),
  );
  touch(pkg, 1);

  const plan = inWorld(w, () => planStaging({ cwd: w.repo }));
  assert.equal(plan.app.form, "dir", "the directory was found first and stays");
  const notes = stagingNotes(plan);
  assert.equal(notes.length, 1, JSON.stringify(notes));
  assert.match(notes[0], /^app_x: passed over app_x\.lgx|^app_x: passed over .*app_x\.lgx/);
  assert.match(notes[0], /could not be ordered by build time/);
});

test("an untimed tie later beaten by a higher version is reported against the copy staged (PLB-2)", () => {
  // Found in this order: a local directory (dated now), an epoch .lgx of the
  // same version (an untimed tie, so the directory stays), then a higher
  // installed version that beats the directory. The .lgx's reason was recorded
  // against the directory and never revisited, so the header said "the copy
  // found first was kept" under a line that staged neither of them.
  const w = world();
  uiPlugin(w.repo, "demo_ui", { deps: ["demo_core"] });
  const dir = coreDir(w.repo, "demo_core", "0.5.0", "LOCAL DIR");
  touch(dir, Date.now());
  const pkg = coreLgx(path.join(w.repo, "demo_core.lgx"), "demo_core", "0.5.0", "LOCAL LGX");
  touch(pkg, 1);
  coreDir(w.install, "demo_core", "0.6.0", "INSTALLED");

  const plan = inWorld(w, () => planStaging({ cwd: w.repo }));
  const core = chosen(plan, "demo_core");
  assert.equal(core.manifest.version, "0.6.0");
  assert.equal(core.provenance, "installed");
  const decision = plan.decisions.find((d) => d.name === "demo_core");
  assert.deepEqual(
    decision.passedOver.map((p) => [p.copy.form, p.reason]).sort(),
    [["dir", "lower-version"], ["lgx", "lower-version"]],
    "each copy lost to the staged 0.6.0 by version, whatever it lost to on the way",
  );
  const notes = stagingNotes(plan);
  assert.equal(notes.length, 2, JSON.stringify(notes));
  for (const n of notes) {
    assert.match(n, /^demo_core: passed over the local 0\.5\.0 at .*for a lower version than the installed 0\.6\.0 staged$/);
  }
  assert.ok(notes.some((n) => n.includes(displayArtifact(pkg))), "the .lgx is named");
  assert.ok(!notes.some((n) => /could not be ordered by build time/.test(n)), "no stale tie note");
});

test("the sweep never replaces the app under test, whatever it finds", () => {
  const w = world();
  uiPlugin(w.repo, "demo_ui", { version: "1.0.0" });
  uiPlugin(path.join(w.parent, "fork"), "demo_ui", { version: "9.0.0" });
  uiPlugin(w.install, "demo_ui", { version: "9.0.0" });
  const plan = inWorld(w, () => planStaging({ cwd: w.repo }));
  assert.equal(plan.app.artifact, path.join(w.repo, "plugins", "demo_ui"));
  assert.equal(plan.app.manifest.version, "1.0.0", "a higher version elsewhere is not the build you pointed at");
});

test("a 0.3.0 object dependency's version range replays a decision already on file, and names the out-of-range copy", () => {
  // demo_core exists TWICE inside the repo tree — once at the top level, once
  // nested one level down (childDirs(root), the monorepo case) — so it is
  // already DECIDED, with one copy passed over, before the app's own
  // dependencySpecs are even read: the app has to be chosen first to know
  // what range it declares. Only once the range is known does the earlier
  // decision get reopened and replayed against it, reconsidering both the
  // copy that was chosen AND every copy passed over — not just whichever one
  // currently holds the name.
  const w = world();
  const dir = path.join(w.repo, "plugins", "demo_ui");
  write(path.join(dir, "qml", "Main.qml"), 'import QtQuick\nItem { objectName: "demo_ui" }\n');
  write(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      name: "demo_ui",
      version: "1.0.0",
      type: "ui_qml",
      view: "qml/Main.qml",
      dependencies: [{ name: "demo_core", version: ">=1.0.0" }],
      // Never a reason to refuse the run — nothing on disk provides it —
      // exercised here for its own sake alongside the range.
      optional_dependencies: ["demo_extra"],
      main: {},
    }),
  );
  coreDir(w.repo, "demo_core", "0.9.0", "OUT OF RANGE");
  coreDir(path.join(w.repo, "vendor"), "demo_core", "1.5.0", "IN RANGE");

  const plan = inWorld(w, () => planStaging({ cwd: w.repo }));
  const core = chosen(plan, "demo_core");
  assert.equal(core.manifest.version, "1.5.0", "the in-range copy is the one staged, whichever was found first");

  const notes = stagingNotes(plan);
  assert.equal(notes.length, 1, JSON.stringify(notes));
  assert.match(notes[0], /^demo_core: passed over .*\(0\.9\.0\), outside the version range the app declares$/);

  assert.ok(!plan.staged.some((s) => s.manifest.name === "demo_extra"), "an optional dependency found nowhere is left out, not an error");
});

// --- variants and the hashed file -------------------------------------------

test("chooseVariant takes the requested variant, else the only one, else asks", () => {
  assert.equal(chooseVariant(["linux-amd64-dev", "linux-amd64"], "linux-amd64-dev"), "linux-amd64-dev");
  assert.equal(chooseVariant(["macos-arm64-dev"], "linux-amd64-dev"), "macos-arm64-dev", "a cross-built package still runs");
  assert.equal(chooseVariant([], "linux-amd64-dev"), "", "a package with no variants unpacks its manifest alone");
  assert.throws(
    () => chooseVariant(["a", "b"], "c", "/x/pkg.lgx"),
    /^Error: pkg\.lgx has no "c" variant\. Available: a, b\. Pass --variant to choose one\.$/,
  );
});

test("mainEntryOf names the file Basecamp loads", () => {
  const has = (...present) => (rel) => present.includes(rel);
  const core = (main) => ({ name: "c", type: "core", dependencies: [], main });
  assert.deepEqual(mainEntryOf(core("c_plugin"), "v", has("c_plugin.so")), [{ kind: "library", rel: "c_plugin.so" }]);
  assert.deepEqual(
    mainEntryOf(core({ v: "a.so", w: "b.so" }), "v", has("a.so", "b.so")),
    [{ kind: "library", rel: "a.so" }],
    "the chosen variant's library",
  );
  assert.deepEqual(
    mainEntryOf(core({ x: "a.so", y: "a.so", z: "b.so" }), "v", has("a.so", "b.so")),
    [{ kind: "library", rel: "a.so" }, { kind: "library", rel: "b.so" }],
    "no key matches, so every distinct library that exists",
  );
  const ui = { name: "u", type: "ui_qml", dependencies: [], view: "qml/Main.qml", main: {} };
  assert.deepEqual(mainEntryOf(ui, "v", has("qml/Main.qml")), [{ kind: "view", rel: "qml/Main.qml" }], "pure QML hashes its view");
  assert.deepEqual(mainEntryOf(ui, "v", has()), [], "and nothing when there is nothing to hash");
});

// --- ST2: the hash is of what was staged, and doctor predicts it --------------

test("the predicted record equals the staged one, for a directory and for a .lgx (ST2)", () => {
  const w = world();
  const ui = uiPlugin(w.repo, "demo_ui", { deps: ["demo_core"] });
  const { store } = outLink(w, "result", {});
  coreLgx(path.join(store, "demo_core.lgx"), "demo_core", "0.5.0", "THE LIBRARY BYTES");

  const plan = inWorld(w, () => planStaging({ cwd: w.repo }));
  const predicted = plan.staged.map((s) => predictStaged(s, VARIANT));
  const staged = stageUserDir(plan.staged, { variant: VARIANT });
  try {
    const recorded = plan.staged.map((s) => recordStaged(s, staged.root, VARIANT));
    assert.deepEqual(recorded, predicted, "doctor's prediction is exactly what the run records");

    const [app, core] = recorded;
    assert.equal(app.hashes[0].kind, "view", "a pure-QML plugin is hashed by its declared view");
    assert.equal(app.hashes[0].path, "qml/Main.qml");
    assert.equal(app.hashes[0].sha256, sha(fs.readFileSync(path.join(staged.root, "plugins", "demo_ui", "qml", "Main.qml"))));
    assert.equal(app.hashes[0].sha256, sha(fs.readFileSync(path.join(ui, "qml", "Main.qml"))));

    assert.equal(core.hashes[0].kind, "library");
    assert.equal(core.hashes[0].path, "demo_core_plugin.so");
    const onDisk = fs.readFileSync(path.join(staged.root, "modules", "demo_core", "demo_core_plugin.so"));
    assert.equal(onDisk.toString(), "THE LIBRARY BYTES");
    assert.equal(core.hashes[0].sha256, sha(onDisk), "the digest of the file Basecamp loads");
    assert.match(core.hashes[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(core.form, "lgx");
    assert.equal(core.artifact, path.join(w.repo, "result", "demo_core.lgx"));
  } finally {
    staged.cleanup();
  }
});

test("a staged copy that differs from its source is caught, because the run hashes the copy (ST2)", () => {
  const w = world();
  uiPlugin(w.repo, "demo_ui", { deps: ["demo_core"] });
  coreDir(w.repo, "demo_core", "0.5.0", "SOURCE");
  const plan = inWorld(w, () => planStaging({ cwd: w.repo }));
  const staged = stageUserDir(plan.staged, { variant: VARIANT });
  try {
    fs.writeFileSync(path.join(staged.root, "modules", "demo_core", "demo_core_plugin.so"), "SOMETHING ELSE");
    const core = plan.staged.find((s) => s.manifest.name === "demo_core");
    assert.notEqual(recordStaged(core, staged.root, VARIANT).hashes[0].sha256, predictStaged(core, VARIANT).hashes[0].sha256);
  } finally {
    staged.cleanup();
  }
});

test("an artifact is shown relative when close by, and absolute when not", () => {
  assert.equal(displayArtifact("/a/b/result/x.lgx", "/a/b"), path.join("result", "x.lgx"));
  assert.equal(displayArtifact("/a/sib/modules/c", "/a/b"), path.join("..", "sib", "modules", "c"));
  assert.equal(displayArtifact("/far/away/x", "/a/b/c/d"), "/far/away/x");
});
