// The crawl's branches that only a particular app can reach.
//
// Everything here is a path the crawl takes only when the app under test does
// something specific — a call that fails while the app is still opening, two
// dispatches in flight when one of them dies, a list of 200 hashes, a toast, a
// control that cannot be reached at all. Each one exists because of a defect
// that shipped, and none of them could be exercised by a fixture until the fake
// Basecamp could be told to behave that way.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { boot } from "../dist/session.js";
import { smoke, findTarget } from "../dist/commands/smoke.js";
import { UiSnapshot } from "../dist/runner/snapshot.js";

const FAKE = fileURLToPath(new URL("./helpers/fake-basecamp.mjs", import.meta.url));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const cleanups = [];
const sessions = [];
test.after(async () => {
  for (const b of sessions.splice(0)) {
    try {
      await b.dispose();
    } catch {
      /* already gone */
    }
  }
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best effort */
    }
  }
});

function appRepo() {
  const root = tmp("sito-edge-repo-");
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "plugins", "demo_ui");
  fs.mkdirSync(path.join(dir, "qml"), { recursive: true });
  fs.writeFileSync(path.join(dir, "qml", "Main.qml"), "Item {}");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ name: "demo_ui", type: "ui_qml", view: "qml/Main.qml", dependencies: [], main: {} }),
  );
  return root;
}

const node = (id, type, text, extra = {}) => ({
  id, type, objectName: "", text, visible: true, enabled: true, children: [], ...extra,
});

const screen = (controls) => ({
  id: "root", type: "QQuickWindow", objectName: "", text: "", visible: true, enabled: true,
  children: [
    node("settings", "Button_QMLTYPE_1", "Settings"),
    node("sidebar-demo_ui", "ItemDelegate_QMLTYPE_7", "demo_ui"),
    {
      id: "dock", type: "QQuickWidget", objectName: "demo_ui", text: "", visible: true, enabled: true,
      children: [{ id: "main", type: "Main_QMLTYPE_9", objectName: "", text: "", visible: true, enabled: true, children: controls }],
    },
  ],
});

function crawl(root, trees, opts = {}) {
  const { env: fakeEnv = {}, ...smokeOpts } = opts;
  const json = path.join(tmp("sito-edge-out-"), "report.json");
  cleanups.push(() => fs.rmSync(path.dirname(json), { recursive: true, force: true }));
  const deps = {
    boot: async (o) => {
      const b = await boot({
        ...o, cwd: root, basecamp: FAKE, timeoutMs: 15_000,
        env: { FAKE_TREES: JSON.stringify(trees), ...fakeEnv },
      });
      sessions.push(b);
      return b;
    },
  };
  const log = console.log;
  const out = [];
  console.log = (...a) => out.push(a.join(" "));
  return smoke({ cwd: root, json, noReport: true, settleMs: 60, noSetup: true, ...smokeOpts }, deps)
    .then((code) => {
      console.log = log;
      return { code, out: out.join("\n"), report: JSON.parse(fs.readFileSync(json, "utf8")) };
    })
    .catch((err) => {
      console.log = log;
      throw err;
    });
}

test("a call that failed while the app was opening is reported, not swallowed", async () => {
  // No click window owns it — it was dispatched before the crawl began — so
  // pairing it to a click is impossible and dropping it entirely was the old
  // behaviour. It has to reach the exit code AND the artifact.
  const root = appRepo();
  const { code, out, report } = await crawl(root, [screen([node("refresh", "Button_QMLTYPE_2", "Refresh")])], {
    limit: 2,
    env: { FAKE_OPEN_FAILURE: "1" },
  });

  assert.equal(code, 1, "a backend call failed; the run must not exit 0");
  assert.equal(report.verdict, "fail", "and the artifact must agree with the exit code");
  assert.match(out, /open demo_ui/);
  assert.ok(
    report.steps.some((s) => JSON.stringify(s).includes("loadState")),
    `the failed call must be named: ${report.steps.map((s) => s.name).join(", ")}`,
  );
});

test("a click whose own call fails is graded failed, and named", async () => {
  const root = appRepo();
  const { code, out, report } = await crawl(root, [screen([node("refresh", "Button_QMLTYPE_2", "Refresh")])], {
    limit: 2,
    env: { FAKE_CLICK_FAILS: "1" },
  });

  assert.equal(code, 1);
  assert.match(out, /FAIL {2}click "Refresh"/);
  const step = report.steps.find((s) => s.name === 'click "Refresh"');
  assert.equal(step.verdict, "fail");
  assert.match(JSON.stringify(step), /doThing/, "the call that failed is named");
});

test("two calls in flight and one failure does not accuse the control", async () => {
  // Pairing is positional — there is no correlation id — so which of the two
  // dispatches died cannot be known. The control stays `unclear`, the hedge
  // stays visible, and the run still counts it: grading it unclear and counting
  // it NOWHERE is how the crawl came to exit 0 on an app whose call had failed.
  const root = appRepo();
  const { code, report } = await crawl(root, [screen([node("refresh", "Button_QMLTYPE_2", "Refresh")])], {
    limit: 2,
    env: { FAKE_CLICK_HEDGE: "1" },
  });

  assert.equal(code, 1, "the failure is counted even though no control is blamed");
  const click = report.steps.find((s) => s.name === 'click "Refresh"');
  assert.notEqual(click.verdict, "fail", "the control is not accused on a guess");
  const hedged = report.steps.find((s) => /outside any click/.test(s.name));
  assert.ok(hedged, `expected the hedge to be reported: ${report.steps.map((s) => s.name).join(", ")}`);
  assert.match(JSON.stringify(hedged), /attribution is a guess/);
});

test("repeated list rows are sampled, and the report says how many were folded", async () => {
  // zonescan lists zone ids as "01010101…", "77777777…", "82010101…". Clicking
  // seven exercises exactly what clicking one does, and then reporting five as
  // "not reached" reads like a failure when it is just noise.
  const root = appRepo();
  const rows = Array.from({ length: 7 }, (_, i) =>
    node(`row${i}`, "ItemDelegate_QMLTYPE_5", `0x${String(i).repeat(8)}abcd`),
  );
  const { code, out } = await crawl(root, [screen(rows)], { limit: 10 });

  assert.equal(code, 0, out);
  assert.match(out, /repeated list row\(s\) skipped — same control, different data/);
});

test("a control the crawl could not get back to is listed as not reached", async () => {
  // The crawl does not backtrack past a screen with no way back, so what it did
  // not reach it simply did not test — and saying so is the difference between
  // a coverage claim and an honest one.
  const root = appRepo();
  const first = screen([
    node("go", "Button_QMLTYPE_3", "Go deeper", { goto: 1 }),
    node("stranded", "Button_QMLTYPE_2", "Stranded"),
  ]);
  // No back affordance at all: "Stranded" can never be reached again.
  const second = screen([node("nothing", "Button_QMLTYPE_4", "Nothing here")]);

  const { code, out } = await crawl(root, [first, second], { limit: 6 });

  assert.equal(code, 0, out);
  assert.match(out, /not reached/);
  assert.match(out, /"Stranded"/);
});

test("a sandbox path on screen is reported as a placeholder, so a report can be diffed", async () => {
  // An app that displays a path shows OUR sandbox, which changes every run — so
  // a report written for diffing would differ every time for no reason at all.
  const root = appRepo();
  const { code, out } = await crawl(
    root,
    [screen([node("path", "Button_QMLTYPE_2", "/tmp/sitometres-home-AbCd12/.local/bin/wallet")])],
    { limit: 2 },
  );

  assert.equal(code, 0, out);
  assert.match(out, /\{home\}/, "the throwaway path is replaced by a stable placeholder");
  assert.doesNotMatch(out, /sitometres-home-AbCd12/, "and the real one is gone");
});

// --- findTarget's looser matches --------------------------------------------

const snapOf = async (controls) => UiSnapshot.capture({ getTree: async () => ({ tree: screen(controls) }) });

test("two controls sharing a stem are only matched when one is a clear winner", async () => {
  // Ambiguous on stem alone: two zones sharing a prefix must not be confused.
  // The longest shared stem wins, but only if it wins outright.
  const snap = await snapOf([
    node("a", "Button_QMLTYPE_2", "Paradox Computer · clearnet"),
    node("b", "Button_QMLTYPE_2", "Paradox Compute Cluster"),
  ]);

  // "Paradox Computer" shares 16 with the first and 15 with the second, so the
  // first wins outright.
  const hit = findTarget(snap, { label: "Paradox Computer", type: "Button_QMLTYPE_2" });
  assert.equal(hit.how, "prefix");
  assert.equal(hit.id, "a");
});

test("a tie on stem is not resolved by guessing", async () => {
  const snap = await snapOf([
    node("a", "Button_QMLTYPE_2", "Paradox Computer one"),
    node("b", "Button_QMLTYPE_2", "Paradox Computer two"),
  ]);
  assert.equal(
    findTarget(snap, { label: "Paradox Computer", type: "Button_QMLTYPE_2" }),
    null,
    "two equally good candidates is not a match; it is an unreachable control",
  );
});

test("the positional fallback addresses a named type, and never a bare MouseArea", async () => {
  // An ordinal among bare QQuickMouseAreas identifies nothing, so it is refused
  // rather than pointed at whatever happens to be third.
  const named = await snapOf([
    node("a", "Button_QMLTYPE_2", "Alpha"),
    node("b", "Button_QMLTYPE_2", "Beta"),
  ]);
  const hit = findTarget(named, { label: "something else entirely", type: "Button_QMLTYPE_2", ordinal: 1 });
  assert.equal(hit.how, "position");
  assert.equal(hit.id, "b");

  const anonymous = await snapOf([
    node("m1", "QQuickMouseArea", "Alpha"),
    node("m2", "QQuickMouseArea", "Beta"),
  ]);
  assert.equal(
    findTarget(anonymous, { label: "something else entirely", type: "QQuickMouseArea", ordinal: 1 }),
    null,
    "position among unnamed hit areas is not identity",
  );
});

test("an app that opens on nothing clickable still reports what failed while opening", async () => {
  // The early return: no controls, so no clicks — but a call failed while the
  // app was coming up, and that has to reach the artifact anyway. Built from the
  // full report builder for exactly this reason; the one-step placeholder it
  // used to emit could express neither a failed open nor a failed setup, which
  // is how a run could exit 1 with failures="0".
  const root = appRepo();
  const bare = {
    id: "root", type: "QQuickWindow", objectName: "", text: "", visible: true, enabled: true,
    children: [
      node("settings", "Button_QMLTYPE_1", "Settings"),
      node("sidebar-demo_ui", "ItemDelegate_QMLTYPE_7", "demo_ui"),
      {
        id: "dock", type: "QQuickWidget", objectName: "demo_ui", text: "", visible: true, enabled: true,
        children: [{ id: "main", type: "Main_QMLTYPE_9", objectName: "", text: "", visible: true, enabled: true, children: [] }],
      },
    ],
  };

  const { code, report } = await crawl(root, [bare], { limit: 2, env: { FAKE_OPEN_FAILURE: "1" } });

  assert.equal(code, 1);
  assert.equal(report.verdict, "fail");
  assert.ok(
    JSON.stringify(report.steps).includes("loadState"),
    `the call that failed while opening must be named: ${JSON.stringify(report.steps.map((s) => s.name))}`,
  );
});

test("a toast is read as the app reporting, and is not queued as a control", async () => {
  // "Wallet CLI path copied" vanishes on its own, so queueing it produces a
  // click on nothing and a bogus "is the handler wired up?". But the text still
  // resolves to a click target through an enclosing container, which is why the
  // crawl has to tell a toast from a control by IDENTITY rather than by text.
  const root = appRepo();
  // A destructive control too, so the crawl has already set something aside by
  // the time the toasts turn up: the toast bookkeeping has to notice what it has
  // already recorded rather than listing the same label twice.
  const before = screen([
    node("wipe", "Button_QMLTYPE_9", "Delete everything"),
    node("save", "Button_QMLTYPE_2", "Save", { goto: 1 }),
  ]);
  // The toast sits deep enough that no handler is beside it — so its role is
  // `message`, the app talking — while still resolving to the MouseArea that
  // covers the whole panel.
  const after = {
    id: "root", type: "QQuickWindow", objectName: "", text: "", visible: true, enabled: true,
    children: [
      node("settings", "Button_QMLTYPE_1", "Settings"),
      node("sidebar-demo_ui", "ItemDelegate_QMLTYPE_7", "demo_ui"),
      {
        id: "dock", type: "QQuickWidget", objectName: "demo_ui", text: "", visible: true, enabled: true,
        children: [{
          id: "main", type: "Main_QMLTYPE_9", objectName: "", text: "", visible: true, enabled: true,
          children: [
            node("save", "Button_QMLTYPE_2", "Save"),
            node("cover", "MouseArea_QMLTYPE_8", ""),
            {
              id: "panel", type: "Column_QMLTYPE_4", objectName: "", text: "", visible: true, enabled: true,
              children: [{
                id: "inner", type: "Item_QMLTYPE_5", objectName: "", text: "", visible: true, enabled: true,
                children: [node("toast", "Text_QMLTYPE_6", "Saved successfully")],
              }],
            },
            // A second toast, on its own hit area. Two of them is not padding:
            // the crawl records each one it sets aside, and the SECOND is the
            // one that has to check it has not already recorded the first.
            {
              id: "panel2", type: "Column_QMLTYPE_4", objectName: "", text: "", visible: true, enabled: true,
              children: [
                node("cover2", "MouseArea_QMLTYPE_8", ""),
                {
                  id: "inner2", type: "Item_QMLTYPE_5", objectName: "", text: "", visible: true, enabled: true,
                  children: [node("toast2", "Text_QMLTYPE_6", "Backup succeeded")],
                },
              ],
            },
          ],
        }],
      },
    ],
  };

  const { code, out, report } = await crawl(root, [before, after], { limit: 6 });

  assert.equal(code, 0, out);
  const clicked = report.steps.filter((s) => /^click /.test(s.name)).map((s) => s.name);
  assert.ok(!clicked.some((c) => /Saved successfully/.test(c)), "a toast is not a control to click");
  assert.ok(!clicked.some((c) => /Backup succeeded/.test(c)), "nor is the second one");
  // And the click that produced it is graded `worked`: prose is the only thing
  // allowed to say the app succeeded.
  const save = report.steps.find((s) => s.name === 'click "Save"');
  assert.match(JSON.stringify(save), /Saved successfully/, "the message is the evidence, and it is kept");

  // Coverage stays honest about what was set aside, and why. A toast dropped
  // from the frontier and recorded nowhere made the run read as a complete
  // sweep when it was not.
  assert.match(out, /skip {2}"Delete everything" \(looks destructive\)/);
});

test("rows revealed by a click are sampled too, not only the ones there at the start", async () => {
  // The collapse runs twice — once over the opening screen and once over every
  // frontier a click reveals — and only the first had a test. A list that
  // arrives after a click is the normal case: it is what loading data looks like.
  const root = appRepo();
  const first = screen([node("load", "Button_QMLTYPE_2", "Load", { goto: 1 })]);
  const rows = Array.from({ length: 6 }, (_, i) =>
    node(`row${i}`, "ItemDelegate_QMLTYPE_5", `0x${String(i).repeat(8)}beef`),
  );
  const second = screen([node("load", "Button_QMLTYPE_2", "Load"), ...rows]);

  const { code, out } = await crawl(root, [first, second], { limit: 12 });

  assert.equal(code, 0, out);
  assert.match(out, /repeated list row\(s\) skipped/);
});
