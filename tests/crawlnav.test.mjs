// The crawl on an app that NAVIGATES.
//
// Clicking is the thing that destroys the frontier: the controls visible at the
// start stop existing, and anything the navigation revealed would never be
// visited. On medusa_ui that meant 3 controls found in a 6,800-line wallet. So
// the crawl keeps a frontier, re-derives it after every click, and — when a
// queued control has gone — tries to get back to it: first by clicking a back
// affordance, then by replaying the one click that revealed it.
//
// None of that could be exercised by a static tree, which is why none of it was
// tested. tests/helpers/fake-basecamp.mjs serves a SEQUENCE of trees now, and a
// node carrying `goto` switches between them when clicked — so a control really
// does go out of reach, and really can come back.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { boot } from "../dist/session.js";
import { smoke } from "../dist/commands/smoke.js";

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
  const root = tmp("sito-nav-repo-");
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
  id,
  type,
  objectName: "",
  text,
  visible: true,
  enabled: true,
  children: [],
  ...extra,
});

/** The Basecamp shell plus this app's dock, holding whatever a screen shows. */
const screen = (controls) => ({
  id: "root",
  type: "QQuickWindow",
  objectName: "",
  text: "",
  visible: true,
  enabled: true,
  children: [
    node("settings", "Button_QMLTYPE_1", "Settings"),
    // The sidebar delegate openApp clicks to open the app. Basecamp labels it
    // with display_name or the module name, and clicking it is the gesture a
    // user makes — so the fixture has to have one.
    node("sidebar-demo_ui", "ItemDelegate_QMLTYPE_7", "demo_ui"),
    {
      id: "dock",
      type: "QQuickWidget",
      objectName: "demo_ui",
      text: "",
      visible: true,
      enabled: true,
      children: [
        { id: "main", type: "Main_QMLTYPE_9", objectName: "", text: "", visible: true, enabled: true, children: controls },
      ],
    },
  ],
});

function crawl(root, trees, opts = {}) {
  const { env: fakeEnv = {}, ...smokeOpts } = opts;
  const json = path.join(tmp("sito-nav-out-"), "report.json");
  cleanups.push(() => fs.rmSync(path.dirname(json), { recursive: true, force: true }));
  const deps = {
    boot: async (o) => {
      const b = await boot({
        ...o,
        cwd: root,
        basecamp: FAKE,
        timeoutMs: 15_000,
        env: { FAKE_TREES: JSON.stringify(trees), ...fakeEnv },
      });
      sessions.push(b);
      return b;
    },
  };
  const log = console.log;
  const out = [];
  console.log = (...a) => out.push(a.join(" "));
  return smoke({ cwd: root, json, noReport: true, settleMs: 40, noSetup: true, ...smokeOpts }, deps)
    .then((code) => {
      console.log = log;
      return { code, out: out.join("\n"), report: JSON.parse(fs.readFileSync(json, "utf8")) };
    })
    .catch((err) => {
      console.log = log;
      throw err;
    });
}

test("a control that navigates away is reached again by going back", async () => {
  // The crawl queues "About" from the first screen, then clicks "Details",
  // which replaces the screen. "About" is gone. Without backtracking it is
  // simply reported as unreachable — a 3-of-8 run instead of a real sweep.
  const root = appRepo();
  const first = screen([
    node("details", "Button_QMLTYPE_2", "Details", { goto: 1 }),
    node("about", "Button_QMLTYPE_3", "About"),
  ]);
  const second = screen([node("back", "Button_QMLTYPE_4", "←", { goto: 0 })]);

  const { code, out, report } = await crawl(root, [first, second], { limit: 6 });

  assert.equal(code, 0, out);
  const clicked = report.steps.filter((s) => /^click /.test(s.name)).map((s) => s.name);
  assert.ok(clicked.includes('click "Details"'), clicked.join(", "));
  assert.ok(clicked.includes('click "About"'), `About was never reached: ${clicked.join(", ")}`);
  assert.match(out, /returned to reach "About"/, "and the report says how it got back");
});

test("a control revealed by another is reached by replaying that click", async () => {
  // Backtracking only unwinds. "Deep" exists only behind "Details", so once the
  // crawl has gone back to the first screen the only way to it is forward: replay
  // the one click that revealed it.
  const root = appRepo();
  const first = screen([
    node("details", "Button_QMLTYPE_2", "Details", { goto: 1 }),
    node("about", "Button_QMLTYPE_3", "About"),
  ]);
  const second = screen([
    node("back", "Button_QMLTYPE_4", "←", { goto: 0 }),
    node("deep", "Button_QMLTYPE_5", "Deep"),
  ]);

  const { code, out, report } = await crawl(root, [first, second], { limit: 8 });

  assert.equal(code, 0, out);
  const clicked = report.steps.filter((s) => /^click /.test(s.name)).map((s) => s.name);
  assert.ok(clicked.includes('click "Deep"'), `Deep was never reached: ${clicked.join(", ")}`);
  assert.match(out, /re-opened "Details" to reach "Deep"/, "and it says which click it replayed");
});

test("a destructive label is skipped, and the report says which word did it", async () => {
  // smoke runs against a throwaway user-dir, so local state is safe — but a
  // wallet app talks to the outside world, and a synthesised click on Send can
  // move real funds. The guard reads every label that resolves to the control.
  const root = appRepo();
  const only = screen([
    node("send", "Button_QMLTYPE_2", "Send funds"),
    node("refresh", "Button_QMLTYPE_3", "Refresh"),
  ]);

  const { code, out, report } = await crawl(root, [only], { limit: 6 });

  assert.equal(code, 0, out);
  const clicked = report.steps.filter((s) => /^click /.test(s.name)).map((s) => s.name);
  assert.ok(clicked.includes('click "Refresh"'));
  assert.ok(!clicked.some((c) => /Send funds/.test(c)), "Send must never be clicked by a crawl");
  assert.match(out, /skip {2}"Send funds" \(looks destructive\)/);
});

test("--skip leaves a control alone, and that is recorded rather than silent", async () => {
  const root = appRepo();
  const only = screen([node("danger", "Button_QMLTYPE_2", "Do the thing"), node("ok", "Button_QMLTYPE_3", "Refresh")]);

  const { code, out, report } = await crawl(root, [only], { limit: 6, skip: ["Do the thing"] });

  assert.equal(code, 0, out);
  assert.match(out, /skip {2}"Do the thing" \(matches --skip/);
  const clicked = report.steps.filter((s) => /^click /.test(s.name)).map((s) => s.name);
  assert.deepEqual(clicked, ['click "Refresh"'], "exactly the one control that was not skipped");
});

test("a relabelled control is still the same control, and the match is not passed off as exact", async () => {
  // Labels are not stable: medusa's zone row is "Paradox Computer" until it is
  // probed and "Paradox Computer · clearnet" afterwards. Both were reported as
  // unreachable while on screen the whole time. A loosened match must be named
  // as loosened — a hedge stated as a fact is the one thing this tool must not do.
  const root = appRepo();
  // Details FIRST, so the crawl navigates away while the zone row is still
  // queued and has to come back for it.
  const first = screen([
    node("go", "Button_QMLTYPE_3", "Details", { goto: 1 }),
    node("zone", "Button_QMLTYPE_2", "Paradox Computer"),
  ]);
  // Same control, renamed, on the screen the crawl comes back to.
  const second = screen([
    node("back", "Button_QMLTYPE_4", "←", { goto: 2 }),
  ]);
  const third = screen([
    node("zone", "Button_QMLTYPE_2", "Paradox Computer · clearnet"),
    node("go", "Button_QMLTYPE_3", "Details"),
  ]);

  const { code, out } = await crawl(root, [first, second, third], { limit: 6 });

  assert.equal(code, 0, out);
  assert.match(out, /matched by prefix; its label had changed/, "the loosened match is disclosed");
});

test("an app Basecamp does not have is diagnosed, not merely timed out", async () => {
  // A populated launcher that lacks the module is the one thing that PROVES the
  // app is absent — an empty one only means the list has not arrived yet, since
  // it is populated asynchronously and is empty for the whole of startup.
  //
  // This is the slowest test in the suite, and deliberately so: openApp spends
  // its full 15s click window preferring a real click on the sidebar before it
  // falls back to asking the launcher, because a click is the gesture a user
  // makes and a stalled package_downloader must not decide whether an app can
  // be opened. Asking the launcher first would make this instant, and would
  // change the timing of the most bug-prone path in the tool to suit a test.
  // "did not open" on its own sends people to debug the wrong thing, so the
  // app's own last log lines come with it.
  const root = appRepo();
  const noDock = {
    id: "root", type: "QQuickWindow", objectName: "", text: "", visible: true, enabled: true,
    children: [
      node("settings", "Button_QMLTYPE_1", "Settings"),
      node("sidebar", "SidebarPanel", ""),
    ],
  };

  const { code, out } = await crawl(root, [noDock], {
    limit: 2,
    env: { FAKE_LAUNCHER: JSON.stringify(["something_else"]) },
  });

  assert.equal(code, 1);
  assert.match(out, /FAIL {2}open demo_ui/);
  assert.match(out, /does not have an app called "demo_ui"/);
  assert.match(out, /Its launcher offers: something_else/, "and it names what Basecamp DOES have");
  // dumpTail: the app's own last log lines, printed under the failure. "did not
  // open" on its own sends people to debug the wrong thing; the log usually
  // already knows why.
  assert.match(out, /^ +\| \[LogosObject\] evaluated an expression/m, "the log tail comes with it");
});
