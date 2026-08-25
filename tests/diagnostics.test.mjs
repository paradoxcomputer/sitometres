// When the app under test breaks, say why — and never lose the report.
//
// Every line of log fixture here is copied verbatim from the real corpus in
// ~/.local/share/Logos/LogosBasecampDev/logs.
import test from "node:test";
import assert from "node:assert/strict";

import { LogBuffer } from "../dist/logs/buffer.js";
import { parseLine, explainOpenFailure } from "../dist/logs/classify.js";
import { Runner } from "../dist/runner/runner.js";

const win = (lines) => {
  const b = new LogBuffer();
  for (const l of lines) b.append(l, "stdout");
  return b.slice(0).map(parseLine);
};

const COMPILE_FAIL =
  'Failed to compile ui_qml view "zonescan_ui" : "file:///home/u/.local/share/Logos/LogosBasecampDev/plugins/zonescan_ui/qml/Main.qml:217:98: Unexpected token `;\'\\n"';
const CORE_DEP_FAIL = 'Failed to load core dependency "lez_indexer_module" for "lez_explorer_ui"';
const UI_HOST_TIMEOUT = 'Timeout waiting for ui-host ready signal for "doom_ui"';

test("a QML compile failure is classified with its file and line", () => {
  const [p] = win([COMPILE_FAIL]);
  assert.equal(p.signal.kind, "ui_compile_failed");
  assert.equal(p.signal.target, "zonescan_ui");
  assert.match(p.signal.file, /zonescan_ui\/qml\/Main\.qml$/);
  assert.equal(p.signal.lineNo, 217);
  assert.match(p.signal.detail, /Unexpected token/);
  assert.equal(p.isError, true);
});

test("the compile error is what the user is told, not a timeout hint", () => {
  const why = explainOpenFailure(win([COMPILE_FAIL]), "zonescan_ui");
  assert.match(why, /did not compile/);
  assert.match(why, /Main\.qml:217/);
  assert.match(why, /Unexpected token/);
});

test("a missing core dependency names the module and how to stage it", () => {
  const why = explainOpenFailure(win([CORE_DEP_FAIL]), "lez_explorer_ui");
  assert.match(why, /lez_indexer_module/);
  assert.match(why, /--with lez_indexer_module/);
});

test("a ui-host that never came ready says so", () => {
  const why = explainOpenFailure(win([UI_HOST_TIMEOUT]), "doom_ui");
  assert.match(why, /ui-host/);
});

test("another app's failure is not reported as yours", () => {
  assert.equal(explainOpenFailure(win([COMPILE_FAIL]), "my_app"), null);
});

test("with no explanation in the log, timeout advice is still honest", () => {
  assert.equal(explainOpenFailure(win(["something unrelated"]), "my_app"), null);
});

// --- the report must survive the run -----------------------------------------

/** A session whose inspector dies partway through, as a crashed app does. */
function dyingSession() {
  const logs = new LogBuffer();
  let calls = 0;
  return {
    logs,
    inspector: {
      getTree: async () => {
        calls++;
        if (calls > 1) throw new Error("socket closed");
        return { tree: { id: "root", type: "Item", children: [] } };
      },
      evaluate: async () => ({ result: true, undefined: false }),
      screenshot: async () => ({ image: "" }),
      clickRef: async () => ({}),
      findAndClick: async () => ({}),
      findByProperty: async () => ({ matches: [{ id: "dock" }] }),
      textInventory: async () => [],
    },
  };
}

test("an app that dies while a step is being checked yields a failed step, not a lost run", async () => {
  const session = dyingSession();
  const runner = new Runner({
    session,
    spec: {
      app: "a",
      timeout: "1s",
      steps: [
        { name: "one", expect: { state: "root.ok" } },
        { name: "two", expect: { state: "root.ok" } },
      ],
    },
    appName: "a",
    logsUsable: false,
    settleMs: 10,
  });

  const result = await runner.run();
  assert.equal(result.steps.length, 2, "both steps are accounted for");
  assert.equal(result.steps[1].verdict, "fail");
  assert.match(result.steps[1].error, /stopped responding/);
  assert.equal(result.verdict, "fail");
});

test("steps completed before a crash are readable from the runner", async () => {
  const session = dyingSession();
  const runner = new Runner({
    session,
    spec: { app: "a", timeout: "1s", steps: [{ name: "one", expect: { state: "root.ok" } }] },
    appName: "a",
    logsUsable: false,
    settleMs: 10,
  });
  await runner.run();
  assert.equal(runner.completed.length, 1, "the report can be built from this even if run() had thrown");
  assert.equal(runner.completed[0].name, "one");
});

// --- the crawl must not lose its report either -------------------------------

test("the crawl's report survives the app dying mid-crawl", async () => {
  // run.ts was fixed for this; the crawl had the identical hole and the task
  // claiming otherwise was ticked without the work being done. UiSnapshot.capture
  // at the top of each iteration is what throws on a dead socket, and it was
  // outside every try.
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/commands/smoke.ts", import.meta.url), "utf8"),
  );
  const loopAt = src.indexOf("while (queue.length > 0 && clicks < limit)");
  const reportAt = src.indexOf("const report: RunReport");
  assert.ok(loopAt > 0 && reportAt > loopAt);

  const between = src.slice(loopAt, reportAt);
  assert.match(
    between,
    /\}\s*catch \(err\) \{[\s\S]*crawlDied/,
    "the crawl loop must be guarded, or a click that kills the app discards the whole report",
  );
  assert.match(src.slice(0, loopAt), /try \{\s*$/m, "and the guard must open before the loop");
});
