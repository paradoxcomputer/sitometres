// Finding the profile that gets an app past its front door.
//
// Discovery searched exactly ONE directory — the app-search root — joining
// every candidate filename onto it, with no upward walk and no lookup relative
// to the app that was actually discovered. So the workflow SKILL.md and README
// both document — write `.sitometres/<app>.setup.yaml` in the app's own repo,
// then run `sitometres <app>` from anywhere — found nothing at all unless you
// happened to be standing in exactly the right directory, and the crawl went on
// to explore the login screen instead of the app.
//
// The miss was silent, which is what made it survive: the `setup <file>` line
// printed only when one was FOUND, so "your profile ran" and "your profile was
// never found, and everything below is a crawl of your onboarding gate" looked
// identical on the terminal. Every test here failed before the fix.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findSetupSpec,
  loadSetupSpec,
  profilesDir,
  resolveSetupSpec,
  setupSearchRoots,
} from "../dist/runner/setup.js";

const made = [];
const tmp = (p) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), p));
  made.push(dir);
  return dir;
};
process.on("exit", () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};

/** Somebody's checkout: a repo root with a .git, and the app under it. */
function checkout() {
  const repo = tmp("sito-repo-");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  const appDir = path.join(repo, "plugins", "gatekeeper_ui");
  fs.mkdirSync(appDir, { recursive: true });
  return { repo, appDir };
}

/** A profile of the shape the docs teach: get past the gate, then stop. */
const PROFILE = [
  "app: gatekeeper_ui",
  "timeout: 45s",
  "ignore_calls:",
  '  - "gatekeeper.pendingRequests"',
  "steps:",
  "  - name: the door asks for a password",
  "    wait_for:",
  '      text: ["Unlock"]',
  "",
].join("\n");

/** Narration is the thing under test in places, so read it rather than hiding it. */
function captured(fn) {
  const log = console.log;
  const stderr = process.stderr.write.bind(process.stderr);
  const out = [];
  const errs = [];
  console.log = (...a) => out.push(a.join(" "));
  process.stderr.write = (s) => (errs.push(String(s)), true);
  try {
    return { value: fn(), out, errs };
  } finally {
    console.log = log;
    process.stderr.write = stderr;
  }
}

// --- which directories are searched -----------------------------------------

test("the search climbs from the app's own directory to its repo root, then cwd", () => {
  const { repo, appDir } = checkout();
  const elsewhere = tmp("sito-cwd-");
  assert.deepEqual(
    setupSearchRoots(elsewhere, appDir),
    [appDir, path.join(repo, "plugins"), repo, elsewhere],
    "only the last of these used to be searched, and only when it happened to be the app-search root",
  );
});

test("the climb stops at the repo root, so a sibling checkout's profile is never read", () => {
  const { repo, appDir } = checkout();
  const elsewhere = tmp("sito-cwd-");
  const above = path.dirname(repo);
  const roots = setupSearchRoots(elsewhere, appDir);
  assert.ok(!roots.includes(above), `${above} holds every other checkout on the machine`);
  assert.equal(roots.at(-2), repo, "the .git directory is where the app's own repo ends");
});

test("a directory already on the climb is not searched a second time", () => {
  const { repo, appDir } = checkout();
  assert.deepEqual(
    setupSearchRoots(repo, appDir),
    [appDir, path.join(repo, "plugins"), repo],
    "running from the repo root adds no fourth entry — the same file would be stat-ed twice and reported by two paths",
  );
  assert.deepEqual(setupSearchRoots(appDir, appDir), [appDir, path.join(repo, "plugins"), repo]);
});

test("with no discovered app there is nothing to climb, only cwd", () => {
  const elsewhere = tmp("sito-cwd-");
  assert.deepEqual(setupSearchRoots(elsewhere, null), [elsewhere]);
});

test("an app outside any repo gives up climbing rather than walking to /", () => {
  // Without the bound, an app nested anywhere deep and not in a checkout walks
  // to the filesystem root, so a stray /sitometres.setup.yaml or one in $HOME
  // becomes a profile every unrelated app silently runs.
  const deep = tmp("sito-deep-");
  const levels = [];
  let dir = deep;
  for (let i = 0; i < 10; i++) {
    dir = path.join(dir, `l${i}`);
    levels.push(dir);
  }
  fs.mkdirSync(dir, { recursive: true });
  assert.deepEqual(
    setupSearchRoots(deep, dir),
    [...levels.slice(2).reverse(), deep],
    "eight directories, nearest first, and then cwd",
  );
});

// --- what is found, and from where ------------------------------------------

test("an app's own profile is found while the command is run somewhere else entirely", () => {
  // The whole point. `sitometres gatekeeper_ui` from ~/notes used to find
  // nothing, run no setup, and crawl the unlock dialog.
  const { repo, appDir } = checkout();
  const elsewhere = tmp("sito-cwd-");
  const own = write(path.join(appDir, ".sitometres", "gatekeeper_ui.setup.yaml"), PROFILE);
  assert.equal(findSetupSpec(elsewhere, "gatekeeper_ui", appDir), own);

  const atRepoRoot = write(path.join(repo, ".sitometres", "gatekeeper_ui.setup.yaml"), PROFILE);
  assert.equal(findSetupSpec(elsewhere, "gatekeeper_ui", appDir), own, "the app's own directory is nearer");
  fs.rmSync(path.join(appDir, ".sitometres"), { recursive: true, force: true });
  assert.equal(
    findSetupSpec(elsewhere, "gatekeeper_ui", appDir),
    atRepoRoot,
    "a monorepo writes one .sitometres/ at the top and expects it to serve the app below",
  );

  assert.equal(
    findSetupSpec(elsewhere, "gatekeeper_ui", null),
    null,
    "and with no app directory to climb from there is nothing — which is what every run used to do",
  );
});

test("the four accepted filenames are tried in a fixed order", () => {
  const { appDir } = checkout();
  const elsewhere = tmp("sito-cwd-");
  const find = () => findSetupSpec(elsewhere, "gatekeeper_ui", appDir);

  const loose = write(path.join(appDir, "sitometres.setup.yaml"), PROFILE);
  assert.equal(find(), loose);
  const looseNamed = write(path.join(appDir, "gatekeeper_ui.setup.yaml"), PROFILE);
  assert.equal(find(), looseNamed, "a name that says which app beats one that does not");
  const dirGeneric = write(path.join(appDir, ".sitometres", "setup.yaml"), PROFILE);
  assert.equal(find(), dirGeneric, ".sitometres/ beats a file loose in the directory");
  const documented = write(path.join(appDir, ".sitometres", "gatekeeper_ui.setup.yaml"), PROFILE);
  assert.equal(find(), documented, "and the path the docs teach wins outright");
});

test("a nearer directory wins over a more specific filename further up", () => {
  const { repo, appDir } = checkout();
  const elsewhere = tmp("sito-cwd-");
  write(path.join(repo, ".sitometres", "gatekeeper_ui.setup.yaml"), PROFILE);
  const loose = write(path.join(appDir, "sitometres.setup.yaml"), PROFILE);
  assert.equal(
    findSetupSpec(elsewhere, "gatekeeper_ui", appDir),
    loose,
    "each directory is searched to exhaustion before its parent is looked at",
  );
});

test("where the command was run is searched too, but after the app's repo", () => {
  const { appDir } = checkout();
  const here = tmp("sito-cwd-");
  const inCwd = write(path.join(here, ".sitometres", "gatekeeper_ui.setup.yaml"), PROFILE);
  assert.equal(findSetupSpec(here, "gatekeeper_ui", appDir), inCwd, "standing next to a profile still works");
  const inApp = write(path.join(appDir, "sitometres.setup.yaml"), PROFILE);
  assert.equal(findSetupSpec(here, "gatekeeper_ui", appDir), inApp, "but the app's own repo outranks the terminal's cwd");
});

test("nothing written anywhere is null, not a path that does not exist", () => {
  const { appDir } = checkout();
  const elsewhere = tmp("sito-cwd-");
  assert.equal(findSetupSpec(elsewhere, "gatekeeper_ui", appDir), null);
  assert.equal(findSetupSpec(elsewhere, "no_such_app", elsewhere), null);
});

// --- packaging ---------------------------------------------------------------

test("the bundled profiles are found from dist/, and medusa_ui is one of them", () => {
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  assert.equal(profilesDir(), path.join(repoRoot, "profiles"), "resolved from the compiled file's own location");
  assert.ok(fs.existsSync(path.join(profilesDir(), "medusa_ui.yaml")), "the profile SKILL.md names must be there");

  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(
    pkg.files.includes("profiles"),
    "a `files` list without profiles/ publishes a tool whose every shipped profile is missing, " +
      "with no symptom beyond crawls that explore login screens",
  );

  const elsewhere = tmp("sito-cwd-");
  assert.equal(
    findSetupSpec(elsewhere, "medusa_ui", elsewhere),
    path.join(profilesDir(), "medusa_ui.yaml"),
    "an app nobody has written a profile for still gets the one that ships",
  );
});

// --- parsing -----------------------------------------------------------------

test("a profile parses into a spec, ignore list and all", () => {
  // `ignore_calls:` is read here, before the app is opened, because it has to
  // be in force for the open step as well. It used to be parsed inside the
  // runner and thrown away, so a profile could declare its app's background
  // poll and the crawl would ignore the declaration — every inert control then
  // reported `ran` off the back of the poll landing in its evidence window.
  const file = write(path.join(tmp("sito-profile-"), ".sitometres", "gatekeeper_ui.setup.yaml"), PROFILE);
  const spec = loadSetupSpec(file);
  assert.equal(spec.app, "gatekeeper_ui");
  assert.equal(spec.timeout, "45s");
  assert.deepEqual(spec.ignoreCalls, ["gatekeeper.pendingRequests"]);
  assert.equal(spec.steps.length, 1);
  assert.equal(spec.steps[0].name, "the door asks for a password");
  assert.deepEqual(spec.steps[0].waitFor, { text: ["Unlock"] }, "snake_case yaml, camelCase api");

  const medusa = loadSetupSpec(path.join(profilesDir(), "medusa_ui.yaml"));
  assert.equal(medusa.app, "medusa_ui");
  assert.deepEqual(medusa.ignoreCalls, ["medusa_core.pendingRequests", "medusa_core.getJob"]);
});

test("a profile that does not parse is null, not a throw part-way through a run", () => {
  const dir = tmp("sito-bad-");
  const cases = [
    ["unclosed.yaml", "app: x\nsteps:\n  - name: [unclosed\n", /sequence/i],
    ["typo.yaml", 'app: x\nsteps:\n  - clik: "Save"\n', /unknown key `clik`/],
    ["prose.yaml", "not a spec at all\n", /must be a mapping/],
  ];
  for (const [name, body, why] of cases) {
    const file = write(path.join(dir, name), body);
    const { value, out } = captured(() => loadSetupSpec(file));
    assert.equal(value, null, `${name} must come back null`);
    assert.equal(out.length, 1, `${name} must say why it was refused`);
    assert.match(out[0], why);
  }

  const { value } = captured(() => loadSetupSpec(path.join(dir, "never-written.yaml")));
  assert.equal(value, null, "a file that vanished between finding it and reading it is not an exception either");
});

test("even the refusal respects a stdout that is carrying a document", () => {
  // The one path that reports a problem was also the one path that wrote
  // straight to stdout, so a profile that did not parse put red prose into the
  // middle of `inspect --json`'s payload — defeating the invariant the whole
  // quiet mode exists to keep, in the case where it matters most.
  const dir = tmp("sito-bad-quiet-");
  const file = write(path.join(dir, "typo.yaml"), 'app: x\nsteps:\n  - clik: "Save"\n');

  const loud = captured(() => loadSetupSpec(file));
  assert.equal(loud.out.length, 1, "by default it still narrates to stdout, where the report is");
  assert.deepEqual(loud.errs, []);

  const quiet = captured(() => loadSetupSpec(file, true));
  assert.deepEqual(quiet.out, [], "nothing may reach stdout");
  assert.equal(quiet.errs.length, 1);
  assert.match(quiet.errs[0], /unknown key `clik`/, "and the reason still reaches the user, on stderr");

  // And through the path a command actually calls.
  const viaResolve = captured(() => resolveSetupSpec({ setup: file, quietNarration: true }, "x", null));
  assert.equal(viaResolve.value, null);
  assert.deepEqual(viaResolve.out, [], "resolveSetupSpec must not leak it either");
});

// --- resolving ---------------------------------------------------------------

test("--no-setup does not go looking, with a profile sitting right there", () => {
  const { appDir } = checkout();
  const elsewhere = tmp("sito-cwd-");
  write(path.join(appDir, ".sitometres", "gatekeeper_ui.setup.yaml"), PROFILE);
  const { value, out } = captured(() =>
    resolveSetupSpec({ noSetup: true, cwd: elsewhere }, "gatekeeper_ui", appDir),
  );
  assert.equal(value, null);
  assert.deepEqual(out, [], "and says nothing about a profile it was told to skip");
});

test("a --setup file that is not there is null, and names the path you typed", () => {
  const missing = path.join(tmp("sito-setup-"), "gate.setup.yaml");
  const { value, out } = captured(() => resolveSetupSpec({ setup: missing }, "gatekeeper_ui", null));
  assert.equal(value, null);
  assert.equal(out.length, 1);
  assert.ok(out[0].includes(missing), "a typo'd --setup must not be reported as a profile that ran");
  assert.match(out[0], /does not exist/);
});

test("a profile that was never found is narrated, not passed over in silence", () => {
  const { appDir } = checkout();
  const elsewhere = tmp("sito-cwd-");
  const { value, out } = captured(() => resolveSetupSpec({ cwd: elsewhere }, "gatekeeper_ui", appDir));
  assert.equal(value, null);
  assert.equal(out.length, 2, "this used to print nothing whatsoever");
  assert.ok(out[0].includes("none found for gatekeeper_ui"));
  assert.ok(
    out[1].includes(".sitometres/gatekeeper_ui.setup.yaml"),
    "and the remedy names the file to write, since a gate is why the crawl found four controls",
  );
});

test("a found profile comes back with the file it came from", () => {
  const { appDir } = checkout();
  const elsewhere = tmp("sito-cwd-");
  const own = write(path.join(appDir, ".sitometres", "gatekeeper_ui.setup.yaml"), PROFILE);
  const { value, out } = captured(() => resolveSetupSpec({ cwd: elsewhere }, "gatekeeper_ui", appDir));
  assert.equal(value.file, own);
  assert.equal(value.spec.app, "gatekeeper_ui");
  assert.deepEqual(value.spec.ignoreCalls, ["gatekeeper.pendingRequests"]);
  assert.deepEqual(out, [], "the `setup <file>` line belongs to the step that runs it");
});

test("an explicit --setup outranks anything discovery would have found", () => {
  // Only the missing-file branch of --setup was pinned, so the override itself
  // was unpinned: reversing the precedence to `findSetupSpec(...) ?? opts.setup`
  // passed the whole file. A user who names a profile is choosing it over the
  // one that ships, and over the one in their repo.
  const { appDir } = checkout();
  const own = write(path.join(appDir, ".sitometres", "gatekeeper_ui.setup.yaml"), PROFILE);
  const chosen = write(
    path.join(tmp("sito-explicit-"), "other.yaml"),
    PROFILE.replace("gatekeeper.pendingRequests", "gatekeeper.somethingElse"),
  );
  const { value } = captured(() => resolveSetupSpec({ cwd: appDir, setup: chosen }, "gatekeeper_ui", appDir));
  assert.equal(value.file, chosen, "the named file wins");
  assert.notEqual(value.file, own);
  assert.deepEqual(value.spec.ignoreCalls, ["gatekeeper.somethingElse"], "and it is the one that was parsed");
});

test("quiet narration keeps prose off a stdout that is carrying a document", () => {
  // `inspect --json` puts a JSON payload on stdout: one line of "setup none
  // found" in the middle of it is the difference between output a program can
  // read and output it cannot.
  const { appDir } = checkout();
  const elsewhere = tmp("sito-cwd-");
  const { value, out, errs } = captured(() =>
    resolveSetupSpec({ cwd: elsewhere, quietNarration: true }, "gatekeeper_ui", appDir),
  );
  assert.equal(value, null);
  assert.deepEqual(out, []);
  assert.equal(errs.length, 2, "the same two lines, on stderr");
  assert.ok(errs[0].includes("none found for gatekeeper_ui"));
});

test("a profile that stops early does not narrate into a stdout carrying a document", async () => {
  // Found by running `inspect --json` against a real medusa wallet: a setup
  // profile whose step could not be performed printed "N later step(s) were not
  // attempted" straight to stdout, in the middle of the JSON payload, and made
  // it unparseable. The same defect as the parse-error line above it, one layer
  // down — the runner does not know whose stdout it is writing to, so it has to
  // be told.
  const { Runner } = await import("../dist/runner/runner.js");
  const { LogBuffer } = await import("../dist/logs/buffer.js");

  const session = {
    logs: new LogBuffer(),
    inspector: {
      getTree: async () => ({ tree: { id: "root", type: "Item", children: [] } }),
      evaluate: async () => ({ result: true, undefined: false }),
      screenshot: async () => ({ image: "" }),
      clickRef: async () => ({}),
    },
  };
  const notes = [];
  const runner = new Runner({
    session,
    spec: {
      app: "a",
      steps: [
        // No artifact directory, so this cannot be performed at all.
        { name: "shot", screenshot: "after" },
        { name: "never reached", expect: { state: "root.ok" } },
      ],
    },
    appName: "a",
    logsUsable: false,
    settleMs: 5,
    onNote: (line) => notes.push(line),
  });

  const { value, out } = captured(() => runner.run());
  await value;
  assert.deepEqual(out, [], "nothing may reach stdout when a caller has taken the note");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /1 later step\(s\) were not attempted/);
});
