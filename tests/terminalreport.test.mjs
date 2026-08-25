// What the run header claims about the machine it is running on.
//
// The header is the only place a caller is told what a run took over, so a
// header that is silent about something destructive reads as a promise that it
// did not happen. Two of these failed before their fix:
//
//   * staging deletes and rewrites the directory of the app under test and of
//     every dependency, and the header named only what SURVIVED ("already
//     installed, left alone") — under a README that said everything else in a
//     caller's --user-dir is left alone, that omission read as "nothing of
//     yours was touched".
//   * the inspector advisory was one fixed sentence whether the app held a
//     throwaway sandbox or the developer's real $HOME and an unlocked wallet —
//     the two cases where an unauthenticated port on every interface actually
//     costs something.
//
// printHeader writes with console.log and returns nothing, so every test here
// captures it; the collector strips colour, because whether this process has a
// TTY is not part of the behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { printHeader } from "../dist/report/terminal.js";
import { configPath, loadConfig, saveConfig } from "../dist/config.js";
import { assessFidelity } from "../dist/runner/fidelity.js";
import { LogBuffer } from "../dist/logs/buffer.js";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Everything printHeader wrote, one entry per console.log call. */
function capture(fn) {
  const out = [];
  const real = console.log;
  console.log = (...args) => out.push(args.map(String).join(" "));
  try {
    fn();
  } finally {
    console.log = real;
  }
  return out;
}

/** The whole report as one line, so wrapped prose can be matched as prose. */
const flatten = (out) => strip(out.join("\n")).replace(/\s+/g, " ").trim();

/** The value rendered against one header key, e.g. field(out, "home"). */
function field(out, key) {
  const line = out.map(strip).find((l) => l.startsWith(`  ${key} `));
  return line === undefined ? null : line.slice(2 + key.length).trim();
}

const verboseLogs = new LogBuffer();
verboseLogs.append('LogosAPIClient: invoking remote method "mod" "doThing" args_count: 0', "stderr");
const verbose = assessFidelity(verboseLogs);
const quiet = assessFidelity(new LogBuffer());

/** The minimum HeaderInfo printHeader needs; every test overrides what it tests. */
const header = (over = {}) => ({
  app: "tip_jar",
  appType: "ui_qml",
  dependencies: [],
  basecamp: "/opt/basecamp/LogosBasecamp",
  userDir: "/tmp/sitometres-userdir-abc",
  logSource: "stderr",
  fidelity: verbose,
  headless: true,
  ...over,
});

// --- the lines every run prints ----------------------------------------------

// The three questions the header exists to answer — which app, which Basecamp,
// which user-dir — and until this test only the first of them was pinned:
// replacing either of the other two with a constant left the file green. The
// user-dir line is the one whose own comment in terminal.ts calls it the
// misleading one, because a --real-home run still printed a throwaway path
// beside it and read more isolated than the run was.
test("the header names the app, the binary and the user-dir it actually used", () => {
  const out = capture(() =>
    printHeader(header({
      app: "medusa_ui",
      appType: "ui_qml",
      dependencies: ["medusa_core"],
      basecamp: "/opt/basecamp/LogosBasecamp",
      userDir: "/tmp/sitometres-userdir-abc",
      logSource: "child stdout (live)",
      headless: false,
    })),
  );
  assert.equal(field(out, "app"), "medusa_ui (ui_qml) -> medusa_core");
  assert.equal(field(out, "basecamp"), "/opt/basecamp/LogosBasecamp");
  assert.equal(field(out, "user-dir"), "/tmp/sitometres-userdir-abc");
  assert.equal(field(out, "mode"), "windowed, logs from child stdout (live)");
});

test("headless is the other half of the mode line, not a default nobody prints", () => {
  const out = capture(() => printHeader(header({ headless: true, logSource: "stderr" })));
  assert.equal(field(out, "mode"), "headless (offscreen), logs from stderr");
});

// --- what staging took over --------------------------------------------------

test("the header names the apps whose install was borrowed, and says they go back", () => {
  const out = capture(() =>
    printHeader(header({
      foreignApps: ["someone_elses_app"],
      replacedApps: ["tip_jar", "wallet_core"],
      restoresUserDir: true,
    })),
  );
  assert.equal(
    field(out, "replaced"),
    "tip_jar, wallet_core (moved aside; put back when the run ends)",
    "both are named — this line did not exist, so the run looked non-destructive",
  );
  assert.equal(field(out, "also here"), "someone_elses_app (already installed, left alone)");
});

test("and says the opposite when the build is being left installed", () => {
  // The two are not interchangeable: one borrows the user's Basecamp, the other
  // changes it. A header that read the same for both would be the more
  // dangerous half going unsaid.
  const out = capture(() => printHeader(header({ replacedApps: ["tip_jar"] })));
  assert.equal(field(out, "replaced"), "tip_jar (staged over, and left there — --keep-staged)");
});

test("an app tested where it lies is named, and is not called replaced", () => {
  const out = capture(() => printHeader(header({ inPlaceApps: ["wallet_core"] })));
  assert.equal(
    field(out, "in place"),
    "wallet_core (already installed here; tested where it lies)",
    "nothing was deleted and nothing was copied, and the header has to say the difference",
  );
  assert.equal(field(out, "replaced"), null, "nothing was replaced, so no replaced line");
});

test("neither line appears when this run took nothing over", () => {
  const out = capture(() => printHeader(header({ replacedApps: [], inPlaceApps: [], foreignApps: [] })));
  assert.equal(field(out, "replaced"), null);
  assert.equal(field(out, "in place"), null);
  assert.equal(field(out, "also here"), null);
  assert.equal(field(out, "app"), "tip_jar (ui_qml)", "the header itself still printed");
});

// --- the inspector advisory --------------------------------------------------

test("a --real-home run with an inspector port warns, and names the port", () => {
  const out = capture(() => printHeader(header({ sandboxHome: null, inspectorPort: 5599 })));
  const flat = flatten(out);
  assert.equal(field(out, "inspector"), "port 5599 (all interfaces, unauthenticated)");
  assert.ok(
    flat.includes(
      "this run exposes your real $HOME, and therefore the wallet and settings Basecamp is configured with through an unauthenticated port on every interface.",
    ),
    `the escalated warning names what is exposed; got: ${flat}`,
  );
  assert.ok(
    flat.includes("Anyone who can reach port 5599 can evaluate code inside the app"),
    "and the port, so it can be recognised in `ss -ltn` output",
  );
  assert.ok(flat.includes("drop --real-home"), "with the way out of it");
});

test("a real $HOME and an unlocked wallet are named together", () => {
  const out = capture(() =>
    printHeader(header({ sandboxHome: null, walletUnlocked: true, inspectorPort: 5599 })),
  );
  assert.ok(
    flatten(out).includes("this run exposes your real $HOME and an unlocked wallet through an unauthenticated port"),
    "the combination the help text recommends for testing against real data is the worst case, not a third phrasing of the same sentence",
  );
});

test("an unlocked wallet is escalated even inside a throwaway home", () => {
  const out = capture(() =>
    printHeader(header({ sandboxHome: "/tmp/sitometres-home-xyz", walletUnlocked: true, inspectorPort: 5599 })),
  );
  assert.ok(
    flatten(out).includes("this run exposes an unlocked wallet through an unauthenticated port on every interface."),
    "a sandboxed $HOME does not lock the wallet the run just unlocked",
  );
});

test("a throwaway home with a locked wallet gets the advisory and nothing louder", () => {
  const out = capture(() => printHeader(header({ sandboxHome: "/tmp/sitometres-home-xyz", inspectorPort: 5599 })));
  const flat = flatten(out);
  assert.equal(
    field(out, "inspector"),
    "port 5599 (all interfaces, unauthenticated)",
    "the standing advisory is always there — the port really is open to the network",
  );
  assert.ok(
    !flat.includes("this run exposes"),
    `nothing of the developer's is reachable through it, so it must not shout; got: ${flat}`,
  );
});

test("attach mode never warns about a $HOME it did not choose", () => {
  const out = capture(() =>
    printHeader(header({ attached: true, sandboxHome: null, walletUnlocked: true, inspectorPort: 5599 })),
  );
  assert.ok(
    !flatten(out).includes("this run exposes"),
    "we did not start that process, did not pick its $HOME and did not open its port",
  );
});

// --- which $HOME the app saw -------------------------------------------------

test("the home line has three states, and attach mode is the one that chose nothing", () => {
  const attached = capture(() => printHeader(header({ attached: true, sandboxHome: null })));
  assert.equal(
    field(attached, "home"),
    "(attached)",
    "rendering attach mode's null as --real-home asserted something the run never did",
  );

  const real = capture(() => printHeader(header({ sandboxHome: null })));
  assert.equal(
    field(real, "home"),
    "your real $HOME (--real-home)",
    "a --real-home run said nothing at all here while user-dir made it look isolated",
  );

  const throwaway = capture(() => printHeader(header({ sandboxHome: "/tmp/sitometres-home-xyz" })));
  assert.equal(
    field(throwaway, "home"),
    "/tmp/sitometres-home-xyz (throwaway; tool dirs link through to the real ones)",
    "and it says what the sandbox does not give you, because tool dirs are symlinked through",
  );

  const unstated = capture(() => printHeader(header()));
  assert.equal(field(unstated, "home"), null, "a caller that knows nothing about $HOME claims nothing");
});

// --- fidelity ----------------------------------------------------------------

test("a quiet session prints the summary and the remedy; a verbose one prints neither", () => {
  assert.equal(quiet.fidelity, "quiet", "an empty startup log means Qt logging never reached us");
  assert.equal(verbose.fidelity, "verbose");

  const quietOut = flatten(capture(() => printHeader(header({ fidelity: quiet }))));
  assert.ok(
    quietOut.includes("No Qt logging is reaching this session, so backend calls, QML errors and console.log are invisible."),
    `the summary is printed verbatim; got: ${quietOut}`,
  );
  assert.ok(
    quietOut.includes("QT_FORCE_STDERR_LOGGING=1"),
    "with the remedy, or the caller is told their evidence is missing and not how to get it back",
  );

  const verboseOut = flatten(capture(() => printHeader(header({ fidelity: verbose }))));
  assert.ok(!verboseOut.includes("QT_FORCE_STDERR_LOGGING"), "a healthy session gets no remedy");
  assert.ok(!verboseOut.includes("Qt logging is on"), "and no summary — the good case is the quiet one on screen");
  assert.equal(field(capture(() => printHeader(header({ fidelity: verbose }))), "app"), "tip_jar (ui_qml)");
});

// --- remembered settings -----------------------------------------------------

/** Run fn against a throwaway XDG_CONFIG_HOME, restoring the real one after. */
function withConfigHome(fn) {
  const previous = process.env.XDG_CONFIG_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sito-config-"));
  process.env.XDG_CONFIG_HOME = dir;
  try {
    fn(dir);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("configPath honours XDG_CONFIG_HOME, and falls back to ~/.config", () => {
  withConfigHome((dir) => {
    assert.equal(configPath(), path.join(dir, "sitometres", "config.json"));
  });

  const previous = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    assert.equal(configPath(), path.join(os.homedir(), ".config", "sitometres", "config.json"));
  } finally {
    if (previous !== undefined) process.env.XDG_CONFIG_HOME = previous;
  }
});

test("a remembered basecamp survives a reload, and a later save merges rather than replaces", () => {
  withConfigHome((dir) => {
    assert.deepEqual(loadConfig(), {}, "nothing is remembered yet");

    const file = saveConfig({ basecamp: "/opt/basecamp/LogosBasecamp" });
    assert.equal(file, path.join(dir, "sitometres", "config.json"), "and it is written where configPath says");
    assert.equal(loadConfig().basecamp, "/opt/basecamp/LogosBasecamp", "the whole point: asked once, remembered");

    // The one thing that varies per machine is exactly the thing a `{...patch}`
    // write would drop the moment anything else is remembered alongside it.
    saveConfig({});
    assert.equal(loadConfig().basecamp, "/opt/basecamp/LogosBasecamp", "an unrelated save must not forget it");

    saveConfig({ basecamp: "/nix/store/abc/bin/LogosBasecamp" });
    assert.equal(loadConfig().basecamp, "/nix/store/abc/bin/LogosBasecamp", "and a real update does take");
  });
});

test("a missing or unreadable config reads as empty rather than throwing", () => {
  withConfigHome((dir) => {
    const file = path.join(dir, "sitometres", "config.json");
    assert.deepEqual(loadConfig(), {}, "no file at all — the first run on any machine");

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ this is not json");
    assert.deepEqual(loadConfig(), {}, "a half-written file must not crash every command that reads settings");

    fs.writeFileSync(file, '"/opt/basecamp/LogosBasecamp"');
    assert.deepEqual(loadConfig(), {}, "valid JSON that is not an object is not a config either");

    fs.writeFileSync(file, '{"basecamp": 42}');
    assert.deepEqual(loadConfig(), {}, "a non-string path must never reach spawn()");

    fs.writeFileSync(file, '{"basecamp": "/opt/basecamp/LogosBasecamp", "unknown": true}');
    assert.deepEqual(
      loadConfig(),
      { basecamp: "/opt/basecamp/LogosBasecamp" },
      "the readable half is kept and nothing else is carried through",
    );
  });
});
