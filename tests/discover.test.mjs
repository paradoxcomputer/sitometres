// Finding a Basecamp, and proving the packages beside it are real.
//
// None of this was reached by a test. `hasInspector` is what decides whether a
// run can drive the UI at all — the inspector is a COMPILE-TIME feature, so a
// wrong answer here either refuses a perfectly good build or promises clicks
// that will never land — and it rests entirely on `searchFile`, whose one
// interesting case is a needle lying across the boundary between two reads.
//
// `locateBasecamp` is the other half, and it is the easiest thing in this repo
// to test dishonestly: its generic search walks the real cwd and the real home
// directory, so on the author's machine it "passes" by finding the author's
// Basecamp. Every test below runs inside sandboxed(), which gives it a home, a
// cwd whose six ancestors are all inside a temp dir, and a config file of its
// own. The empty-sandbox test at the end is what makes the positive ones mean
// anything.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { discoverApps, hasInspector, locateBasecamp, readLgxManifest, staleRememberedBasecamp, better, compareCopies, knownBuildTime, satisfiesRange } from "../dist/app/discover.js";

/** The line the inspector prints when its server comes up; hasInspector looks for exactly this. */
const NEEDLE = "[QmlInspector] Inspector server listening on port";

/** searchFile's read size. The boundary case below has to know it. */
const CHUNK = 1 << 20;

const made = [];
function tmp(prefix) {
  // realpath because process.cwd() reports a resolved path, and the origins
  // locateBasecamp builds are compared against these strings exactly.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in for a Basecamp build. hasInspector reads bytes and a size, never
 * an ELF header, so filler plus the inspector's own log line is a faithful
 * fixture; 4 KB clears the 1 KB floor under which it does not bother scanning.
 */
function fakeBinary(file, { inspector = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const filler = Buffer.alloc(4096, 0x41);
  fs.writeFileSync(file, inspector ? Buffer.concat([filler, Buffer.from(NEEDLE, "utf8"), filler]) : filler);
  fs.chmodSync(file, 0o755);
  return file;
}

/** What `sitometres doctor --set-basecamp` leaves behind for the next run. */
function remember(binPath) {
  const file = path.join(process.env.XDG_CONFIG_HOME, "sitometres", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ basecamp: binPath }));
}

const ENV = ["HOME", "XDG_CONFIG_HOME", "SITOMETRES_BASECAMP", "LOGOS_BASECAMP_BIN", "LDEX_BASECAMP_DIR"];

/**
 * A machine with no Basecamp on it.
 *
 * locateBasecamp consults $HOME, the config file and six levels of parent
 * directory above the cwd, so all three have to be ours or the test is really
 * a test of the developer's laptop. The cwd is deep enough (six levels inside
 * the temp root) that the walk upwards never leaves the sandbox.
 */
function sandboxed(fn) {
  const saved = ENV.map((k) => [k, process.env[k]]);
  const savedCwd = process.cwd();
  const root = tmp("sito-basecamp-");
  const home = path.join(root, "home");
  const cwd = path.join(root, "work", "a", "b", "c", "d");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  for (const k of ENV) delete process.env[k];
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  process.chdir(cwd);
  try {
    return fn({ root, home, cwd });
  } finally {
    process.chdir(savedCwd);
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --- scanning a build for the inspector --------------------------------------

test("a build carrying the inspector's log line is recognised, and one without it is not", () => {
  const dir = tmp("sito-inspector-");
  const enabled = fakeBinary(path.join(dir, "LogosBasecamp"), { inspector: true });
  const shipping = fakeBinary(path.join(dir, "shipped", "LogosBasecamp"), { inspector: false });

  assert.equal(hasInspector(enabled), true);
  assert.equal(hasInspector(shipping), false, "the AppImage builds with ENABLE_QML_INSPECTOR off, and must not be claimed drivable");
});

test("a needle straddling two reads is still found", () => {
  // searchFile reads 1 MiB at a time and carries needle.length - 1 bytes over
  // into the next buffer. Drop the carry — the obvious way to write a chunked
  // search — and a real 100 MB Basecamp whose string happens to land on a
  // megabyte boundary is reported as having no inspector, which reads to the
  // developer as "this build cannot be driven" and is wrong.
  const dir = tmp("sito-straddle-");
  const start = CHUNK - 20;
  assert.ok(start < CHUNK && start + NEEDLE.length > CHUNK, "the fixture only tests anything if the needle spans the boundary");

  const big = Buffer.alloc(CHUNK + 4096, 0x41);
  Buffer.from(NEEDLE, "utf8").copy(big, start);
  const file = path.join(dir, "LogosBasecamp");
  fs.writeFileSync(file, big);
  fs.chmodSync(file, 0o755);

  assert.equal(hasInspector(file), true);

  // The same file with one byte of the needle overwritten is a control: it
  // proves the match above came from the needle and not from the file's size.
  big[start + 10] = 0x41;
  fs.writeFileSync(file, big);
  assert.equal(hasInspector(file), false);
});

test("a file too small to be a build is not scanned at all", () => {
  // The floor keeps us from reading every stray text file beside a binary.
  // Both halves hold the same needle, so it is the size that decides.
  const dir = tmp("sito-small-");
  const file = path.join(dir, "LogosBasecamp");
  fs.writeFileSync(file, Buffer.concat([Buffer.from(NEEDLE, "utf8"), Buffer.alloc(600, 0x41)]));
  assert.equal(hasInspector(file), false, "600 bytes is below the 1 KB floor");

  fs.writeFileSync(file, Buffer.concat([Buffer.from(NEEDLE, "utf8"), Buffer.alloc(2048, 0x41)]));
  assert.equal(hasInspector(file), true, "the same content over the floor is scanned");
});

test("a path that does not exist answers no, rather than throwing", () => {
  // locateBasecamp calls this on candidates that may have been removed since
  // they were remembered; an ENOENT escaping here would abort discovery.
  const dir = tmp("sito-missing-");
  assert.equal(hasInspector(path.join(dir, "nowhere", "LogosBasecamp")), false);
});

test("the nix wrapper layout is scanned through to the dot-file holding the real binary", () => {
  // `result/bin/LogosBasecamp` from a nix build is a shell script that execs
  // `.LogosBasecamp` beside it. Scanning only the named path finds no Qt
  // strings in a script and calls the build inspector-less.
  const dir = tmp("sito-wrapper-");
  const wrapper = path.join(dir, "LogosBasecamp");
  fs.writeFileSync(wrapper, '#!/bin/sh\nexec "$(dirname "$0")/.LogosBasecamp" "$@"\n' + "# padding\n".repeat(256));
  fs.chmodSync(wrapper, 0o755);

  assert.equal(hasInspector(wrapper), false, "the wrapper is over the size floor and genuinely holds no inspector string");

  fakeBinary(path.join(dir, ".LogosBasecamp"), { inspector: true });
  assert.equal(hasInspector(wrapper), true, "the sibling is where the ELF actually is");
});

test("the nix bundle layout, whose sibling is named .<base>.elf, is scanned too", () => {
  // The bug this pins: `nix build .#bin-bundle-dir-inspector` — the build the
  // README and SKILL.md tell you to make — ships `bin/.LogosBasecamp.elf`, and
  // no `bin/.LogosBasecamp` at all. Probing only the extensionless sibling read
  // the shell wrapper, found no Qt strings, and told the user their bundle had
  // "no QML inspector compiled in" when it did.
  const dir = tmp("sito-bundle-");
  const wrapper = path.join(dir, "LogosBasecamp");
  fs.writeFileSync(wrapper, '#!/bin/sh\nBASE="LogosBasecamp"\nREAL="$(dirname "$0")/.$BASE.elf"\nexec "$REAL" "$@"\n' + "# padding\n".repeat(256));
  fs.chmodSync(wrapper, 0o755);

  assert.equal(hasInspector(wrapper), false, "the wrapper alone holds no inspector string");

  fakeBinary(path.join(dir, ".LogosBasecamp.elf"), { inspector: true });
  assert.equal(fs.existsSync(path.join(dir, ".LogosBasecamp")), false, "the bundle really does not ship the extensionless name");
  assert.equal(hasInspector(wrapper), true, "the .elf sibling is where the bundle's ELF actually is");
});

test("the makeWrapper layout, whose sibling is named .<base>-wrapped, is scanned too", () => {
  // `.<base>-wrapped` is what nixpkgs' own makeWrapper/wrapProgram emits — the
  // most common wrapped-binary spelling there is, and present in this very
  // ecosystem as logos-liblogos/bin/.logos_host-wrapped. Probing only the two
  // hand-rolled spellings called such a build inspector-less.
  const dir = tmp("sito-mkwrapper-");
  const wrapper = path.join(dir, "LogosBasecamp");
  fs.writeFileSync(wrapper, '#!/bin/sh\nexec "$(dirname "$0")/.LogosBasecamp-wrapped" "$@"\n' + "# padding\n".repeat(256));
  fs.chmodSync(wrapper, 0o755);

  assert.equal(hasInspector(wrapper), false, "the wrapper alone holds no inspector string");

  fakeBinary(path.join(dir, ".LogosBasecamp-wrapped"), { inspector: true });
  assert.equal(hasInspector(wrapper), true, "the -wrapped sibling is where makeWrapper puts the ELF");
});

test("a symlink to the binary is resolved before its siblings are looked for", () => {
  // `dirname` on a symlink gives the LINK's directory, so the dot-sibling was
  // looked for next to the link and never found. A `result/` DIRECTORY symlink
  // survives that (dirname resolves through it), which is why the common nix
  // layout hid this; a link to the binary itself does not, and locateBasecamp
  // hands hasInspector the unresolved path.
  const dir = tmp("sito-symlink-");
  const store = path.join(dir, "store", "bin");
  fs.mkdirSync(store, { recursive: true });
  const real = path.join(store, "LogosBasecamp");
  fs.writeFileSync(real, '#!/bin/sh\nexec "$(dirname "$0")/.LogosBasecamp.elf" "$@"\n' + "# padding\n".repeat(256));
  fs.chmodSync(real, 0o755);
  fakeBinary(path.join(store, ".LogosBasecamp.elf"), { inspector: true });

  const linkDir = path.join(dir, "elsewhere");
  fs.mkdirSync(linkDir, { recursive: true });
  const link = path.join(linkDir, "LogosBasecamp");
  fs.symlinkSync(real, link);

  // The ELF is beside the target, not beside the link; nothing inspector-ish
  // sits in linkDir at all.
  assert.equal(hasInspector(link), true, "the sibling lives beside the resolved path");
});

// --- choosing which Basecamp to run ------------------------------------------

test("an explicit --basecamp is used alone, whatever else the machine has to offer", () => {
  sandboxed(({ root, cwd }) => {
    const picked = fakeBinary(path.join(root, "picked", "bin", "LogosBasecamp"), { inspector: true });
    const other = fakeBinary(path.join(root, "other", "bin", "LogosBasecamp"), { inspector: true });
    process.env.SITOMETRES_BASECAMP = other;
    process.env.LOGOS_BASECAMP_BIN = other;
    remember(other);
    fakeBinary(path.join(cwd, "result", "bin", "LogosBasecamp"), { inspector: true });

    // Falling back to any of the four decoys would run the suite against
    // something the developer did not pick.
    assert.deepEqual(locateBasecamp(picked), [{ path: picked, origin: "--basecamp", inspectorEnabled: true }]);
  });
});

test("each source of the chosen binary names itself, in precedence order", () => {
  sandboxed(({ root }) => {
    // The origin is printed in the run header and by `doctor`: "which of my
    // three settings won?" is otherwise unanswerable.
    const fromEnv = fakeBinary(path.join(root, "env", "LogosBasecamp"), { inspector: true });
    const fromLegacyEnv = fakeBinary(path.join(root, "legacy", "LogosBasecamp"), { inspector: false });
    const fromConfig = fakeBinary(path.join(root, "config-bin", "LogosBasecamp"), { inspector: true });
    remember(fromConfig);
    process.env.SITOMETRES_BASECAMP = fromEnv;
    process.env.LOGOS_BASECAMP_BIN = fromLegacyEnv;

    assert.deepEqual(locateBasecamp(), [
      { path: fromEnv, origin: "$SITOMETRES_BASECAMP", inspectorEnabled: true },
    ]);

    delete process.env.SITOMETRES_BASECAMP;
    assert.deepEqual(locateBasecamp(), [
      // A build with the inspector compiled out is still returned; it is the
      // caller that refuses to drive it, and it can only do that if this flag
      // is measured rather than assumed.
      { path: fromLegacyEnv, origin: "$LOGOS_BASECAMP_BIN", inspectorEnabled: false },
    ]);

    delete process.env.LOGOS_BASECAMP_BIN;
    assert.deepEqual(locateBasecamp(), [
      { path: fromConfig, origin: "remembered (sitometres doctor --set-basecamp)", inspectorEnabled: true },
    ]);
  });
});

test("a stale remembered path keeps searching and says so; an explicit one stops", () => {
  sandboxed(({ root, cwd }) => {
    const gone = path.join(root, "deleted", "LogosBasecamp");
    const inTree = fakeBinary(path.join(cwd, "result", "bin", "LogosBasecamp"), { inspector: true });

    // Explicit first: it must NOT quietly fall through to the perfectly good
    // binary sitting in the tree, and it must not blame the config file.
    assert.deepEqual(locateBasecamp(gone), []);
    assert.equal(staleRememberedBasecamp, null);

    // The same dead path, this time merely remembered. It used to return []
    // here too, so a machine with a working Basecamp in the usual place
    // reported "No Basecamp binary found" forever and nothing named the config
    // file that caused it.
    remember(gone);
    assert.deepEqual(locateBasecamp(), [
      { path: inTree, origin: `${cwd}/result (nix build)`, inspectorEnabled: true },
    ]);
    assert.equal(staleRememberedBasecamp, gone, "doctor has to be able to name the path that went bad");

    // And the complaint is per-search, not sticky: the next run, with the
    // config repaired, must not still be reporting it.
    remember(inTree);
    locateBasecamp();
    assert.equal(staleRememberedBasecamp, null);
  });
});

test("a chosen path that exists but is not executable counts as no binary at all", () => {
  sandboxed(({ root }) => {
    // Without the execute bit, spawn() raises an 'error' event several seconds
    // later, which is not a diagnostic anyone can act on.
    const unrunnable = path.join(root, "notexec", "LogosBasecamp");
    fs.mkdirSync(path.dirname(unrunnable), { recursive: true });
    fs.writeFileSync(unrunnable, Buffer.alloc(4096, 0x41));
    fs.chmodSync(unrunnable, 0o644);

    assert.deepEqual(locateBasecamp(unrunnable), []);

    fs.chmodSync(unrunnable, 0o755);
    assert.deepEqual(locateBasecamp(unrunnable), [
      { path: unrunnable, origin: "--basecamp", inspectorEnabled: false },
    ]);
  });
});

test("candidates come back in a fixed order: configured dir, the tree you stand in, then home", () => {
  sandboxed(({ root, home, cwd }) => {
    const configured = path.join(root, "elsewhere");
    process.env.LDEX_BASECAMP_DIR = configured;

    // Deliberately spread across the layouts: $LDEX_BASECAMP_DIR has only a
    // bundle, the cwd has both a plain nix result and a bundle beside it, and a
    // checkout sits one level up.
    const bundle = fakeBinary(path.join(configured, "result-bundle", "bin", "LogosBasecamp"));
    const here = fakeBinary(path.join(cwd, "result", "bin", "LogosBasecamp"));
    const hereBundle = fakeBinary(path.join(cwd, "result-bundle", "bin", "LogosBasecamp"));
    const parent = path.dirname(cwd);
    const above = fakeBinary(path.join(parent, "logos-basecamp", "result", "bin", "LogosBasecamp"));
    const inHome = fakeBinary(path.join(home, "logos-basecamp", "result-bundle", "bin", "LogosBasecamp"));
    const installed = fakeBinary(path.join(home, ".local", "bin", "logos-basecamp"));

    // Order is the whole answer here: the first entry is what a run uses. Two
    // orders are being pinned at once — which root is consulted first, and,
    // within one root, that `result` (what `nix build` just wrote) is preferred
    // to the `result-bundle` left over from a packaging run.
    assert.deepEqual(
      locateBasecamp().map((b) => [b.path, b.origin]),
      [
        [bundle, `${configured}/result-bundle`],
        [here, `${cwd}/result (nix build)`],
        [hereBundle, `${cwd}/result-bundle`],
        [above, `${parent}/logos-basecamp/result (nix build)`],
        [inHome, `${home}/logos-basecamp/result-bundle`],
        [installed, "~/.local/bin"],
      ],
    );
  });
});

test("one binary reachable by two paths is offered once", () => {
  sandboxed(({ home, cwd }) => {
    // ~/logos-basecamp is routinely a symlink to the checkout you are standing
    // in. Listing the same build twice makes `doctor` read as if there were a
    // choice to make.
    const real = fakeBinary(path.join(cwd, "result", "bin", "LogosBasecamp"), { inspector: true });
    const link = path.join(home, "logos-basecamp", "result", "bin");
    fs.mkdirSync(link, { recursive: true });
    fs.symlinkSync(real, path.join(link, "LogosBasecamp"));

    assert.deepEqual(locateBasecamp(), [
      { path: real, origin: `${cwd}/result (nix build)`, inspectorEnabled: true },
    ]);
  });
});

test("a machine with no Basecamp anywhere reports none, and blames nothing", () => {
  // This is also the proof that the sandbox above is really empty: every
  // positive result in this file came from a fixture, not from the developer's
  // own install.
  sandboxed(() => {
    assert.deepEqual(locateBasecamp(), []);
    assert.equal(staleRememberedBasecamp, null, "nothing configured is a different remedy from a remembered path gone stale");
  });
});

// --- packaged bundles ---------------------------------------------------------

/**
 * A .lgx is a gzipped tar. This writes just enough of one for the reader in
 * discover.js, which looks only at the name, the size and the type flag.
 */
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

test("a package that contains the library it declares is loadable, by whichever name it was built under", () => {
  const root = tmp("sito-lgxfull-");
  fs.writeFileSync(
    path.join(root, "built_ui.lgx"),
    lgx([
      // A built manifest names the library WITHOUT an extension; the packager
      // picks .so/.dylib/.dll per platform, so checking the bare name alone
      // condemns every real package.
      ["manifest.json", JSON.stringify({ name: "built_ui", type: "ui_qml", view: "qml/Main.qml", main: "built_ui_plugin" })],
      ["variants/linux-amd64-dev/qml/Main.qml", "import QtQuick"],
      ["variants/linux-amd64-dev/built_ui_plugin.so", "\x7fELF not really"],
    ]),
  );
  fs.writeFileSync(
    path.join(root, "built_core.lgx"),
    lgx([
      ["manifest.json", JSON.stringify({ name: "built_core", type: "core", main: { "linux-amd64-dev": "libcore.so", "darwin-arm64": "libcore.dylib" } })],
      ["variants/linux-amd64-dev/libcore.so", "\x7fELF not really"],
    ]),
  );

  const apps = discoverApps(root);
  const ui = apps.find((a) => a.manifest.name === "built_ui");
  assert.equal(ui.incomplete, undefined, 'main: "built_ui_plugin" is satisfied by built_ui_plugin.so');
  assert.equal(ui.origin, "built_ui.lgx", "the header prints where the bundle came from, relative to where you ran");

  const core = apps.find((a) => a.manifest.name === "built_core");
  assert.equal(core.incomplete, undefined, "one variant of the map being present is enough — no package holds every platform");
  assert.equal(core.slot, "modules");
  assert.equal(apps[0].slot, "plugins", "UI plugins sort first: they are the ones a UI test can drive");
});

test("a package missing its declared library is called out, under every name it might carry", () => {
  const root = tmp("sito-lgxhollow-");
  fs.writeFileSync(
    path.join(root, "hollow_ui.lgx"),
    lgx([
      ["manifest.json", JSON.stringify({ name: "hollow_ui", type: "ui_qml", view: "qml/Main.qml", main: "hollow_plugin" })],
      ["variants/linux-amd64-dev/README", "the payload, such as it is"],
    ]),
  );
  fs.writeFileSync(
    path.join(root, "hollow_core.lgx"),
    lgx([
      ["manifest.json", JSON.stringify({ name: "hollow_core", type: "core", main: { "linux-amd64-dev": "libhollow.so", "darwin-arm64": "libhollow.dylib" } })],
      ["variants/linux-amd64-dev/README", "the payload, such as it is"],
    ]),
  );

  const apps = discoverApps(root);
  // Staging one of these yields a user-dir Basecamp silently declines to list,
  // which is indistinguishable from a hang — so the reason has to be exact
  // enough to act on.
  assert.equal(
    apps.find((a) => a.manifest.name === "hollow_ui").incomplete,
    'hollow_ui.lgx declares its view "qml/Main.qml" and its library "hollow_plugin", which is not inside the package',
  );
  assert.equal(
    apps.find((a) => a.manifest.name === "hollow_core").incomplete,
    'hollow_core.lgx declares its library "libhollow.so / libhollow.dylib", which is not inside the package',
  );
});

test("a package's dependency list keeps its names, in either form, and nothing else", () => {
  const root = tmp("sito-lgxdeps-");
  const file = path.join(root, "deps.lgx");
  fs.writeFileSync(
    file,
    lgx([
      [
        "manifest.json",
        JSON.stringify({
          name: "deps_app",
          dependencies: ["medusa_core", 7, null, "wallet", { name: "nested" }, { version: "^1" }, ["x"]],
        }),
      ],
    ]),
  );

  const m = readLgxManifest(file);
  // These names go straight into the set of apps the session stages and doctor
  // resolves; a number, or an object with no name, is a lookup for an app that
  // cannot exist, and it is printed in the run header as if it were one. An
  // object WITH a name is Basecamp 0.3.0's dependency entry
  // (readDependencyEntry), and its name is a real dependency.
  assert.deepEqual(m.dependencies, ["medusa_core", "wallet", "nested"]);
  assert.equal(m.type, "unknown", "a manifest with no type is not assumed to be something Basecamp loads");
  assert.equal(m.name, "deps_app");

  assert.equal(readLgxManifest(path.join(root, "not-here.lgx")), null, "a missing bundle is not a crash");
});

// --- a build beats the repo it came from -------------------------------------

test("a built package wins over the source checkout beside it, whatever the clock says", () => {
  // Nix normalises every store timestamp to the epoch, so a freshly built
  // `result/*.lgx` reports 1970 while the source next to it reports today. The
  // tiebreak was recency, so the SOURCE won every time — and staging a source
  // checkout produces a directory carrying `metadata.json` and no
  // `manifest.json`, which Basecamp silently declines to list. The run then died
  // with "sidebar has not rendered <app>", which reads like the app's fault.
  // Observed on a nix-built ldex_ui.
  const root = tmp("sito-built-");
  try {
    // The source repo: the manifest a developer edits, modified just now.
    const src = path.join(root, "ui");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "Main.qml"), "import QtQuick\nItem {}\n");
    fs.writeFileSync(
      path.join(src, "metadata.json"),
      JSON.stringify({ name: "demo_ui", version: "0.1.0", type: "ui_qml", view: "Main.qml", dependencies: [] }),
    );

    // The build: the manifest Basecamp actually loads, stamped 1970.
    const built = path.join(root, "plugins", "demo_ui");
    fs.mkdirSync(built, { recursive: true });
    fs.writeFileSync(path.join(built, "Main.qml"), "import QtQuick\nItem {}\n");
    fs.writeFileSync(
      path.join(built, "manifest.json"),
      JSON.stringify({ name: "demo_ui", version: "0.1.0", type: "ui_qml", view: "Main.qml", dependencies: [] }),
    );
    for (const f of ["Main.qml", "manifest.json"]) fs.utimesSync(path.join(built, f), 1, 1);
    fs.utimesSync(built, 1, 1);

    const found = discoverApps(root).filter((a) => a.manifest.name === "demo_ui");
    assert.equal(found.length, 1, "one app, two copies of it");
    assert.equal(found[0].artifact, built, "the build is what gets staged");
    assert.equal(found[0].built, true);
    assert.ok(
      found[0].builtAt < Date.now() - 86_400_000,
      "and it won despite being the older of the two by decades",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the source is still found when it is the only copy, so the tool can say so", () => {
  // Discovery must not hide a source checkout: finding it is what lets boot
  // report "not built" instead of "no Logos app found here".
  const root = tmp("sito-srconly-");
  try {
    const src = path.join(root, "ui");
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, "Main.qml"), "Item {}");
    fs.writeFileSync(
      path.join(src, "metadata.json"),
      JSON.stringify({ name: "demo_ui", type: "ui_qml", view: "Main.qml", dependencies: [] }),
    );
    const found = discoverApps(root).filter((a) => a.manifest.name === "demo_ui");
    assert.equal(found.length, 1);
    assert.equal(found[0].built, false, "and it is marked as what it is");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("better() prefers a build over a source tree before it looks at anything else", () => {
  // Direct, because the ordering of the rules is the behaviour: completeness
  // first, then built-ness, and only then version and recency.
  const app = (over) => ({
    manifest: { name: "demo_ui", type: "ui_qml", dependencies: [] },
    artifact: "/x",
    form: "dir",
    built: false,
    slot: "plugins",
    origin: "x",
    label: "demo_ui",
    builtAt: 0,
    ...over,
  });

  assert.equal(better(app({ built: true, builtAt: 1 }), app({ built: false, builtAt: Date.now() })), true);
  assert.equal(better(app({ built: false, builtAt: Date.now() }), app({ built: true, builtAt: 1 })), false);
  // Completeness still outranks it: an incomplete build is no use at all.
  assert.equal(
    better(app({ built: true, incomplete: "missing its library" }), app({ built: false })),
    false,
    "a build that cannot load does not beat anything",
  );
  // And between two builds, the newer one still wins, when both times are real.
  const t = Date.UTC(2026, 8, 1);
  assert.equal(better(app({ built: true, builtAt: t + 60_000 }), app({ built: true, builtAt: t })), true);
  assert.equal(better(app({ built: true, builtAt: t }), app({ built: true, builtAt: t + 60_000 })), false);
});

test("1 ms and 2 ms are not build times, and neither ever loses to a known one", () => {
  // The case above used to be written with builtAt 2 against 1, and passed on
  // the strength of a comparison between two epoch timestamps. A nix store
  // dates every file to the epoch, which is how a fresh `result/*.lgx` lost to
  // an older installed copy: 1970 read as old rather than as unknown.
  const app = (over) => ({
    manifest: { name: "demo_core", type: "core", version: "0.5.0", dependencies: [] },
    artifact: "/x",
    form: "lgx",
    built: true,
    slot: "modules",
    origin: "x",
    label: "demo_core",
    provenance: "local",
    builtAt: 0,
    ...over,
  });
  assert.equal(knownBuildTime(app({ builtAt: 0 })), null, "0 was never read");
  assert.equal(knownBuildTime(app({ builtAt: 1 })), null, "1 ms is the store's epoch, not a build");
  assert.equal(knownBuildTime(app({ builtAt: 86_399_999 })), null, "nor is anything in the first day");
  assert.equal(knownBuildTime(app({ builtAt: 86_400_000 })), 86_400_000);

  const known = app({ builtAt: Date.now() - 3_600_000, artifact: "/known" });
  for (const unknown of [app({ builtAt: 1 }), app({ builtAt: 0 })]) {
    // Whichever side is the incumbent, an unknown time decides nothing: the
    // incumbent stays and the reason says why.
    assert.deepEqual(compareCopies(known, unknown), { wins: false, reason: "untimed-tie" });
    assert.deepEqual(compareCopies(unknown, known), { wins: false, reason: "untimed-tie" });
  }
  // Two epoch times are not ordered either; 2 does not beat 1.
  assert.deepEqual(compareCopies(app({ builtAt: 2 }), app({ builtAt: 1 })), { wins: false, reason: "untimed-tie" });
});

test("compareCopies applies its rules in order and names why the loser lost", () => {
  const t = Date.UTC(2026, 8, 1);
  const app = (over) => ({
    manifest: { name: "demo_core", type: "core", version: "0.5.0", dependencies: [] },
    artifact: "/x",
    form: "dir",
    built: true,
    slot: "modules",
    origin: "x",
    label: "demo_core",
    provenance: "local",
    builtAt: t,
    ...over,
  });
  const v = (version, over = {}) => app({ manifest: { name: "demo_core", type: "core", version, dependencies: [] }, ...over });
  assert.deepEqual(compareCopies(app(), undefined), { wins: true, reason: null });
  assert.deepEqual(compareCopies(app({ incomplete: "no library" }), app()), { wins: false, reason: "incomplete" });
  assert.deepEqual(compareCopies(app(), app({ incomplete: "no library" })), { wins: true, reason: "incomplete" });
  assert.deepEqual(compareCopies(app({ built: false }), app()), { wins: false, reason: "source-only" });
  // Version before provenance: a higher installed version beats a local build.
  assert.deepEqual(
    compareCopies(v("0.5.0", { provenance: "installed" }), v("0.4.0")),
    { wins: true, reason: "lower-version" },
  );
  // Provenance before time: an installed copy touched later still loses.
  assert.deepEqual(
    compareCopies(app({ provenance: "installed", builtAt: t + 86_400_000 }), app()),
    { wins: false, reason: "installed" },
  );
  assert.deepEqual(
    compareCopies(app({ builtAt: 1 }), app({ provenance: "installed", builtAt: t + 86_400_000 })),
    { wins: true, reason: "installed" },
    "an epoch-dated local build beats a newer install of the same version",
  );
  // Time last, and only when both are known.
  assert.deepEqual(compareCopies(app({ builtAt: t + 1000 }), app()), { wins: true, reason: "older" });
  assert.deepEqual(compareCopies(app(), app({ builtAt: t + 1000 })), { wins: false, reason: "older" });
});

test("a .lgx manifest is normalised the same way one read off disk is", () => {
  // readLgxManifest used to hand-roll its own copy of the normaliser, and a
  // copy drifts: when the real one learned to drop a field whose declared type
  // the JSON does not honour, a .lgx still handed `"version": 2` through, and
  // compareVersions — reached just by deciding which of two copies of an app to
  // run — still died on it with `a.split is not a function`.
  const root = tmp("sito-lgxtypes-");
  const file = path.join(root, "bad_types.lgx");
  fs.writeFileSync(
    file,
    lgx([
      [
        "manifest.json",
        JSON.stringify({
          name: "demo_ui",
          type: "ui_qml",
          version: 2,
          view: 9,
          display_name: { a: 1 },
          dependencies: ["medusa_core", 7],
          // A built manifest ships these and nothing declares them; they stay.
          hashes: { linux: "abc" },
        }),
      ],
    ]),
  );
  const m = readLgxManifest(file);
  assert.equal(m.version, undefined, "a numeric version must not reach compareVersions");
  assert.equal(m.view, undefined);
  assert.equal(m.display_name, undefined);
  assert.equal(m.name, "demo_ui");
  assert.deepEqual(m.dependencies, ["medusa_core"], "and the list is still filtered to strings");
  assert.deepEqual(m.hashes, { linux: "abc" }, "an undeclared key is still carried through");
  // `better(x, undefined)` returns true before it compares anything, so it would
  // have passed with this fix deleted. Give it two candidates so the version
  // tiebreak is actually reached - that is the line that used to throw.
  const t = Date.UTC(2026, 8, 1);
  const older = { manifest: m, origin: "a.lgx", form: "lgx", builtAt: t };
  const newer = { manifest: { ...m, version: "9.9.9" }, origin: "b.lgx", form: "lgx", builtAt: t + 1000 };
  assert.equal(better(newer, older), true, "a version that is absent rather than a number can be compared at all");

  // A well-formed one is untouched, and a nameless one is still not a manifest.
  const good = path.join(root, "good.lgx");
  fs.writeFileSync(good, lgx([["manifest.json", JSON.stringify({ name: "demo_ui", type: "ui_qml", version: "1.2.3" })]]));
  assert.equal(readLgxManifest(good).version, "1.2.3");
  const nameless = path.join(root, "nameless.lgx");
  fs.writeFileSync(nameless, lgx([["manifest.json", JSON.stringify({ type: "ui_qml" })]]));
  assert.equal(readLgxManifest(nameless), null);
});

// --- satisfiesRange: the npm-style ranges a 0.3.0 object dependency uses ----

test("satisfiesRange reads exact versions, comparators, caret, tilde and wildcards", () => {
  // Unreadable input: neither side of the question can be answered.
  assert.equal(satisfiesRange(undefined, "^1.0.0"), null, "no version to test at all");
  assert.equal(satisfiesRange("not-a-version", "^1.0.0"), null);
  assert.equal(satisfiesRange("1.0.0", "not a range!!"), null, "a range this cannot parse either");

  // An exact version, and a partial one read as the range it names.
  assert.equal(satisfiesRange("1.2.3", "1.2.3"), true);
  assert.equal(satisfiesRange("1.2.4", "1.2.3"), false);
  assert.equal(satisfiesRange("1.2.5", "1.2"), true, "1.2 means >=1.2.0 <1.3.0");
  assert.equal(satisfiesRange("1.3.0", "1.2"), false);

  // Caret: locks the leftmost non-zero component.
  assert.equal(satisfiesRange("1.5.0", "^1.2.0"), true);
  assert.equal(satisfiesRange("2.0.0", "^1.2.0"), false);
  assert.equal(satisfiesRange("1.1.9", "^1.2.0"), false, "below the floor");

  // Tilde: patch-level only.
  assert.equal(satisfiesRange("1.2.9", "~1.2.0"), true);
  assert.equal(satisfiesRange("1.3.0", "~1.2.0"), false);

  // Bare comparators.
  assert.equal(satisfiesRange("2.5.0", ">=1.0.0"), true);
  assert.equal(satisfiesRange("0.9.0", ">=1.0.0"), false);
  assert.equal(satisfiesRange("2.0.0", ">1.9"), true);
  assert.equal(satisfiesRange("1.9.5", ">1.9"), false, "still inside the 1.9.x the comparator names");
  assert.equal(satisfiesRange("1.0.0", "<=1.0.0"), true);
  assert.equal(satisfiesRange("1.0.1", "<1.1"), true);
  assert.equal(satisfiesRange("1.1.0", "<1.1"), false);

  // Wildcards: any component, or the whole range.
  assert.equal(satisfiesRange("1.9.0", "1.x"), true);
  assert.equal(satisfiesRange("2.0.0", "1.x"), false);
  assert.equal(satisfiesRange("9.9.9", "*"), true);

  // Multiple comparators (AND, space-separated) and alternatives (OR, `||`).
  assert.equal(satisfiesRange("1.5.0", ">=1.0.0 <2.0.0"), true);
  assert.equal(satisfiesRange("2.5.0", ">=1.0.0 <2.0.0"), false, "readable, just outside both bounds");
  assert.equal(satisfiesRange("2.0.0", "^1.0.0 || ^2.0.0"), true);
  assert.equal(satisfiesRange("3.0.0", "^1.0.0 || ^2.0.0"), false);
});
