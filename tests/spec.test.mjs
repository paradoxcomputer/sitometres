import test from "node:test";
import assert from "node:assert/strict";
import { validateSpec, parseDuration, asArray } from "../dist/spec/schema.js";
import { toJUnit } from "../dist/report/machine.js";

test("parses durations in every accepted form", () => {
  assert.equal(parseDuration(1500, 0), 1500);
  assert.equal(parseDuration("1500", 0), 1500);
  assert.equal(parseDuration("1.5s", 0), 1500);
  assert.equal(parseDuration("2m", 0), 120000);
  assert.equal(parseDuration(undefined, 42), 42);
  assert.throws(() => parseDuration("soon", 0), /cannot parse duration/);
});

test("accepts snake_case in YAML and exposes camelCase", () => {
  const spec = validateSpec({
    app: "tip_jar",
    ignore_calls: ["medusa_core.pendingRequests"],
    steps: [{ click: "Go", expect: { not_text: ["gone"], calls_succeed: false } }],
  });
  assert.deepEqual(spec.ignoreCalls, ["medusa_core.pendingRequests"]);
  assert.deepEqual(spec.steps[0].expect.notText, ["gone"]);
  assert.equal(spec.steps[0].expect.callsSucceed, false);
});

test("rejects a step with two actions, naming both", () => {
  assert.throws(
    () => validateSpec({ steps: [{ click: "a", open: "b" }] }),
    /has 2 actions \(open, click\)|has 2 actions \(click, open\)/,
  );
});

test("rejects a step with no action and no expectation", () => {
  assert.throws(() => validateSpec({ steps: [{ name: "nothing" }] }), /no action and no expect/);
});

test("rejects an unknown expectation and lists the valid ones", () => {
  assert.throws(
    () => validateSpec({ steps: [{ click: "a", expect: { txt: ["x"] } }] }),
    /unknown expectation `txt`.*Known:/s,
  );
});

test("requires steps", () => {
  assert.throws(() => validateSpec({ app: "x" }), /missing required list `steps`/);
});

test("asArray normalises scalar and list forms", () => {
  assert.deepEqual(asArray("a"), ["a"]);
  assert.deepEqual(asArray(["a", "b"]), ["a", "b"]);
  assert.deepEqual(asArray(undefined), []);
});

test("only directories Basecamp could actually load are accepted", async () => {
  const { discoverApps } = await import("../dist/app/discover.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sito-test-"));
  const mk = (slot, name, manifest, files = []) => {
    const d = path.join(root, slot, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify({ name, ...manifest }));
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
      fs.writeFileSync(path.join(d, f), "x");
    }
    return d;
  };

  // Rejected: declares a library it does not ship (medusa's modules/medusa_core).
  mk("modules", "stub_core", { type: "core", main: { "linux-amd64-dev": "stub_core_plugin.so" } });
  // Rejected: a SOURCE CHECKOUT. Declares view + a string main, ships neither —
  // this is ~/Documents/ldex/zonescan-ui, which used to be staged verbatim and
  // produced a user-dir of CMakeLists.txt that Basecamp silently ignored.
  mk("plugins", "src_ui", { type: "ui_qml", view: "qml/Main.qml", main: "src_ui_plugin" },
     ["CMakeLists.txt", "src/qml/Main.qml"]);
  // Accepted: pure QML. An EMPTY main map is not a promise of a library.
  mk("plugins", "pure_ui", { type: "ui_qml", main: {}, view: "qml/Main.qml" }, ["qml/Main.qml"]);
  // Accepted: ships the library it declares, in either manifest shape.
  mk("modules", "built_core", { type: "core", main: { "linux-amd64-dev": "built_core.so" } }, ["built_core.so"]);
  mk("modules", "str_core", { type: "core", main: "str_core_plugin" }, ["str_core_plugin.so"]);

  const found = Object.fromEntries(discoverApps(root).map((a) => [a.manifest.name, a.incomplete]));
  assert.match(found.stub_core, /library "stub_core_plugin\.so"/);
  assert.match(found.src_ui, /view "qml\/Main\.qml"/);
  assert.match(found.src_ui, /source checkout/);
  assert.equal(found.pure_ui, undefined, "pure QML with its view present must be accepted");
  assert.equal(found.built_core, undefined);
  assert.equal(found.str_core, undefined, "a string main whose library exists must be accepted");

  fs.rmSync(root, { recursive: true, force: true });
});

test("a higher version beats a newer file, and a stub beats neither", async () => {
  const { compareVersions, discoverApps } = await import("../dist/app/discover.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  assert.equal(compareVersions("0.3.0", "0.2.0"), 1);
  assert.equal(compareVersions("0.2.0", "0.3.0"), -1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.3.0", undefined), 0, "unknown version must not decide");
  assert.equal(compareVersions("abc", "0.1.0"), 0, "unparseable must not decide");

  // The real case: a stale 0.2.0 package with a FRESH mtime alongside 0.3.0.
  // Going on mtime alone staged 0.2.0, whose wallet-CLI resolution differs, and
  // produced a failure that belonged to sitometres rather than to the app.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sito-ver-"));
  const mk = (rel, version, mtime) => {
    const d = path.join(root, rel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "manifest.json"),
      JSON.stringify({ name: "thing", type: "core", version, main: { "linux-amd64-dev": "thing.so" } }));
    fs.writeFileSync(path.join(d, "thing.so"), "x");
    for (const f of fs.readdirSync(d)) fs.utimesSync(path.join(d, f), mtime / 1000, mtime / 1000);
  };
  mk("modules/thing", "0.3.0", 1_700_000_000_000);          // older file, newer version
  mk("sub/modules/thing", "0.2.0", 1_900_000_000_000);      // newer file, older version

  const picked = discoverApps(root).find((a) => a.manifest.name === "thing");
  assert.equal(picked.manifest.version, "0.3.0", `version must outrank mtime, got ${picked.manifest.version}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Basecamp's own internals are never offered as the app under test", async () => {
  const { discoverApps } = await import("../dist/app/discover.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sito-scope-"));
  const mk = (rel, manifest, files = []) => {
    const d = path.join(root, rel);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify(manifest));
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
      fs.writeFileSync(path.join(d, f), "x");
    }
  };
  // Complete built trees that ship inside Basecamp — loadable, never the target.
  mk("plugins/main_ui", { name: "main_ui", type: "ui_qml", main: {}, view: "qml/Main.qml" }, ["qml/Main.qml"]);
  mk("plugins/package_manager_ui", { name: "package_manager_ui", type: "ui_qml", main: {}, view: "qml/Main.qml" }, ["qml/Main.qml"]);
  // A type Basecamp cannot load from a user-dir: no view, no main, so every
  // completeness check passes by vacuity (logos-basecamp/qt-ios).
  mk("plugins/ios_thing", { name: "ios_thing", type: "app" });
  // A deliberate sandbox-escape fixture living under tests/.
  mk("tests/sandbox/evil_app", { name: "evil_app", type: "ui_qml", view: "Main.qml" }, ["Main.qml"]);
  // The one real app.
  mk("plugins/real_ui", { name: "real_ui", type: "ui_qml", main: {}, view: "qml/Main.qml" }, ["qml/Main.qml"]);

  const names = discoverApps(root).filter((a) => !a.incomplete).map((a) => a.manifest.name);
  assert.deepEqual(names, ["real_ui"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("nix's many result-* outputs are all searched for packages", async () => {
  const { discoverApps } = await import("../dist/app/discover.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const zlib = await import("node:zlib");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sito-lgx-"));

  // Minimal tar containing manifest.json, gzipped — the .lgx shape.
  const manifest = JSON.stringify({ name: "phase_app", type: "ui_qml", main: {}, view: "qml/Main.qml" });
  const header = Buffer.alloc(512);
  header.write("manifest.json", 0);
  header.write("000644 ", 100);
  header.write("0000000 ", 108);
  header.write("0000000 ", 116);
  header.write(Buffer.byteLength(manifest).toString(8).padStart(11, "0") + " ", 124);
  header.write("00000000000 ", 136);
  header.write("        ", 148);
  header.write("0", 156);
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  const body = Buffer.alloc(512);
  body.write(manifest);
  const tar = Buffer.concat([header, body, Buffer.alloc(1024)]);

  // can-it-run-doom keeps its bundles in result-phase2 / result-picker, not ./result.
  fs.mkdirSync(path.join(root, "result-phase2"), { recursive: true });
  fs.writeFileSync(path.join(root, "result-phase2", "logos-phase_app-module.lgx"), zlib.gzipSync(tar));

  const found = discoverApps(root).map((a) => a.manifest.name);
  assert.deepEqual(found, ["phase_app"], "a result-* sibling must be searched too");
  fs.rmSync(root, { recursive: true, force: true });
});

test("the freshest build of an app wins, and a stub never does", async () => {
  const { discoverApps } = await import("../dist/app/discover.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sito-fresh-"));

  const write = (dir, name, mtime, withLib) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"),
      JSON.stringify({ name, type: "core", main: { "linux-amd64-dev": `${name}.so` } }));
    if (withLib) fs.writeFileSync(path.join(dir, `${name}.so`), "x");
    for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), mtime / 1000, mtime / 1000);
  };

  // An old real build under modules/, a newer one nested a level down.
  const old = 1_700_000_000_000;
  const fresh = 1_800_000_000_000;
  write(path.join(root, "modules", "widget"), "widget", old, true);
  write(path.join(root, "sub", "modules", "widget"), "widget", fresh, true);
  const picked = discoverApps(root).find((a) => a.manifest.name === "widget");
  assert.ok(picked.artifact.includes("sub"), `expected the newer build, got ${picked.artifact}`);

  // A stub must never win, however new it is.
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "sito-fresh2-"));
  write(path.join(root2, "modules", "gadget"), "gadget", old, true);
  write(path.join(root2, "sub", "modules", "gadget"), "gadget", fresh, false);
  const picked2 = discoverApps(root2).find((a) => a.manifest.name === "gadget");
  assert.equal(picked2.incomplete, undefined, "a manifest-only stub must not win on freshness");
  assert.ok(!picked2.artifact.includes("sub"));

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root2, { recursive: true, force: true });
});

test("one broken manifest does not abort discovery", async () => {
  const { discoverApps } = await import("../dist/app/discover.js");
  const { malformed } = await import("../dist/app/manifest.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sito-broken-"));

  // A stray file with invalid JSON anywhere under the search path used to throw
  // out of discovery, so every command failed before finding the real app.
  const bad = path.join(root, "plugins", "broken");
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, "manifest.json"), "{ this is not json");

  const good = path.join(root, "plugins", "fine");
  fs.mkdirSync(path.join(good, "qml"), { recursive: true });
  fs.writeFileSync(path.join(good, "manifest.json"),
    JSON.stringify({ name: "fine", type: "ui_qml", main: {}, view: "qml/Main.qml" }));
  fs.writeFileSync(path.join(good, "qml", "Main.qml"), "x");

  const before = malformed.length;
  const found = discoverApps(root).map((a) => a.manifest.name);
  assert.deepEqual(found, ["fine"], "the good app must still be found");
  assert.ok(malformed.length > before, "the broken manifest must be recorded, not silently dropped");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a setup profile is found in the app's repo before the bundled one", async () => {
  const { findSetupSpec, profilesDir } = await import("../dist/commands/smoke.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  // The profile shipped with sitometres is the fallback, not the override.
  assert.ok(fs.existsSync(path.join(profilesDir(), "medusa_ui.yaml")), "the medusa profile must ship");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sito-setup-"));
  assert.equal(findSetupSpec(root, "medusa_ui"), path.join(profilesDir(), "medusa_ui.yaml"));

  fs.mkdirSync(path.join(root, ".sitometres"), { recursive: true });
  const own = path.join(root, ".sitometres", "medusa_ui.setup.yaml");
  fs.writeFileSync(own, "app: medusa_ui\nsteps: []\n");
  assert.equal(findSetupSpec(root, "medusa_ui"), own, "the app's own profile must win");

  assert.equal(findSetupSpec(root, "no_such_app"), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("every shipped profile is a valid spec", async () => {
  const { validateSpec } = await import("../dist/spec/schema.js");
  const { profilesDir } = await import("../dist/commands/smoke.js");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const YAML = await import("yaml");
  const dir = profilesDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  assert.ok(files.length > 0, "at least one profile must ship");
  for (const f of files) {
    // A profile that does not parse would strand the crawl on the login screen.
    const spec = validateSpec(YAML.parse(fs.readFileSync(path.join(dir, f), "utf8")));
    assert.ok(spec.steps.length > 0, `${f} has no steps`);
  }
});

test("the report table fits the terminal at any width", async () => {
  const { tableLayout } = await import("../dist/report/runreport.js");
  const labels = ["Add your local sequencer", "SEQUENCER ADDRESS", "x"];
  for (const term of [60, 80, 100, 120, 200]) {
    const { controlW, outcomeW, detailW } = tableLayout(term, labels);
    // "  │ c │ o │ d │" — indent 2, then three cells each padded by a space
    // either side, separated by four box characters.
    const total = 2 + 1 + 1 + controlW + 1 + 1 + 1 + outcomeW + 1 + 1 + 1 + detailW + 1 + 1;
    assert.ok(total <= Math.min(term, 140) + 1, `width ${term}: table was ${total}`);
    assert.ok(detailW >= 12, "the detail column must stay readable");
  }
});

test("the status line never exceeds the terminal width", async () => {
  const { fitDetail } = await import("../dist/report/status.js");
  const phase = "Running";
  const secs = "17s";
  const long = 'sidebar has not rendered "ZoneScan Lite" — asking Basecamp to open it';
  for (const width of [40, 60, 80, 120, 200]) {
    const detail = fitDetail(phase, long, secs, width);
    // Same budget the renderer uses: 2 indent + spinner + space + phase + " · " + detail + space + secs
    const total = 2 + 1 + 1 + phase.length + (detail ? 3 + detail.length : 0) + 1 + secs.length;
    assert.ok(total <= width, `width ${width}: line was ${total} chars`);
  }
  // A short detail is left alone.
  assert.equal(fitDetail(phase, "ok", secs, 120), "ok");
  // An impossibly narrow terminal drops the detail rather than wrapping.
  assert.equal(fitDetail(phase, long, secs, 16), "");
});

test("JUnit maps inconclusive to skipped, not to a pass or a failure", () => {
  const xml = toJUnit({
    tool: "sitometres", version: "0.1.0", app: "tip_jar", basecamp: "/bin/x",
    fidelity: { fidelity: "quiet", qtLogLines: 0, moduleLogLines: 0, summary: "no logging" },
    verdict: "inconclusive", durationMs: 1000,
    steps: [
      { index: 0, name: "opens", action: "", verdict: "pass", durationMs: 10, checks: [], callsObserved: [] },
      { index: 1, name: "calls backend", action: "", verdict: "inconclusive", durationMs: 20, callsObserved: [],
        checks: [{ kind: "calls", description: "calls x.y", verdict: "inconclusive", detail: "no call logging" }] },
      { index: 2, name: "breaks", action: "", verdict: "fail", durationMs: 30, callsObserved: [],
        checks: [{ kind: "text", description: "sees \"Done\"", verdict: "fail" }] },
    ],
  });
  assert.match(xml, /tests="3" failures="1" skipped="1"/);
  assert.match(xml, /<skipped message="calls x\.y: no call logging"\/>/);
  assert.match(xml, /<failure message="sees &quot;Done&quot;">/);
});
