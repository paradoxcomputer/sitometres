// How the crawl grades a click, and when it may say "worked".
import test from "node:test";
import assert from "node:assert/strict";

import { LogBuffer } from "../dist/logs/buffer.js";
import { parseLine, pairFailures, UNATTRIBUTED } from "../dist/logs/classify.js";
import { classifyOutcome } from "../dist/runner/outcome.js";
import { UiSnapshot } from "../dist/runner/snapshot.js";

const win = (lines) => {
  const b = new LogBuffer();
  for (const l of lines) b.append(l, "stdout");
  return b.slice(0).map(parseLine);
};

const graded = (over = {}) =>
  classifyOutcome({
    window: win([]),
    newLabels: [],
    newMessageLabels: [],
    appName: "my_app",
    logsUsable: true,
    ignoreCalls: [],
    ...over,
  });

test('a "Done" button revealed by a click is not the app confirming anything', () => {
  // `worked` is the one verdict SKILL.md licences a caller to report as success.
  const asControl = graded({ newLabels: ["Done"], newMessageLabels: [] });
  assert.notEqual(asControl.outcome, "worked", "a control's own name is not a confirmation");
  // The screen did change — a button appeared — so the honest grade is that
  // something happened and nothing said whether it worked.
  assert.equal(asControl.outcome, "unclear");

  // The same word as PROSE does count — that is the app reporting.
  const asMessage = graded({ newLabels: ["Done"], newMessageLabels: ["Done"] });
  assert.equal(asMessage.outcome, "worked");
});

test("a failure word on a button is not an error either", () => {
  const asControl = graded({ newLabels: ["Retry failed items"], newMessageLabels: [] });
  assert.notEqual(asControl.outcome, "failed", "a button named after errors is not an error");
  const asMessage = graded({ newLabels: ["Transfer failed"], newMessageLabels: ["Transfer failed"] });
  assert.equal(asMessage.outcome, "failed");
});

test("the app's own console output still counts, whatever is on screen", () => {
  const r = graded({ window: win(["qml: ✓ saved"]), newLabels: [], newMessageLabels: [] });
  assert.equal(r.outcome, "worked");
});

test("labelsWithRole tells a control's name, prose, and the ambiguous middle apart", async () => {
  // This test used to guard on `UiSnapshot.fromTree`, which does not exist —
  // so it returned before every assertion and still printed ok. It was the only
  // test mapping a real tree to label roles.
  const { UiSnapshot } = await import("../dist/runner/snapshot.js");
  const tree = {
    id: "1", type: "QQuickItem", text: "", visible: true, enabled: true, children: [
      // A proper control: the label is the button's contentItem.
      { id: "2", type: "Button_QMLTYPE_1", text: "", visible: true, enabled: true, children: [
        { id: "3", type: "Text_QMLTYPE_2", text: "Send", visible: true, enabled: true, children: [] },
      ]},
      // Prose with no handler anywhere near it.
      { id: "4", type: "Text_QMLTYPE_2", text: "Transfer complete", visible: true, enabled: true, children: [] },
      // The hand-rolled card: indistinguishable from either.
      { id: "5", type: "Column_QMLTYPE_3", text: "", visible: true, enabled: true, children: [
        { id: "6", type: "Text_QMLTYPE_2", text: "Done", visible: true, enabled: true, children: [] },
        { id: "7", type: "MouseArea_QMLTYPE_4", text: "", visible: true, enabled: true, children: [] },
      ]},
    ],
  };
  const snap = await UiSnapshot.capture({ getTree: async () => ({ tree }) });
  const roles = Object.fromEntries(snap.labelsWithRole().map((r) => [r.text, r.role]));
  assert.equal(roles["Send"], "control");
  assert.equal(roles["Transfer complete"], "message");
  assert.equal(roles["Done"], "ambiguous", "a card's text could be either, so the tool must not guess");
});

test("ambiguous text drives no verdict, in either direction", () => {
  // Both halves of the trap: counting it as a confirmation reported success for
  // a Done button; counting it as a control name silently discarded a real
  // "Transfer failed" message. It is evidence the screen changed, nothing more.
  for (const label of ["Done", "✓ Completed", "Transfer failed: insufficient funds", "Retry failed items"]) {
    const r = graded({ newLabels: [label], newMessageLabels: [] });
    assert.equal(r.outcome, "unclear", `${label} must not decide the verdict`);
  }
});

// --- a reply that times out long after its click -----------------------------

test("a failure names the dispatch it was matched to", () => {
  const lines = [
    'LogosAPIClient: invoking remote method "mod" "slowThing" args_count: 0',
    '[LogosObject] RemoteLogosObject::callMethod "slowThing" args: 0',
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
  ];
  const w = win(lines);
  const [f] = [...pairFailures(w).values()];
  assert.equal(f.method, "slowThing");
  assert.equal(typeof f.anchorSeq, "number", "without this the failure cannot be traced to its click");
  const anchor = w.find((p) => p.line.seq === f.anchorSeq);
  assert.match(anchor.line.text, /callMethod "slowThing"/);
});

test("an unanchored failure carries no anchor to mis-attribute", () => {
  const [f] = [...pairFailures(win(["RemoteLogosObject: callRemoteMethod failed or timed out: 1"])).values()];
  assert.equal(f.method, UNATTRIBUTED);
  assert.equal(f.anchorSeq, undefined);
});

test("a later click's healthy dispatch is not stolen as the victim", () => {
  // The dangerous case: click A dispatches something slow, click B dispatches
  // something healthy, A's timeout fires inside B's window. Pairing pops B's
  // anchor and reports it confidently failed — naming a call that succeeded.
  // The anchor seq is what lets the crawl charge it to A instead.
  const lines = [
    'LogosAPIClient: invoking remote method "mod" "slowThing" args_count: 0',   // click A
    '[LogosObject] RemoteLogosObject::callMethod "slowThing" args: 0',
    'LogosAPIClient: invoking remote method "mod" "fastThing" args_count: 0',   // click B
    '[LogosObject] RemoteLogosObject::callMethod "fastThing" args: 0',
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",               // A's timeout
  ];
  const w = win(lines);
  const [f] = [...pairFailures(w).values()];
  const anchor = w.find((p) => p.line.seq === f.anchorSeq);
  assert.ok(anchor, "the failure must record which dispatch it was paired to");
  // Positional pairing still picks the nearest — that is inherent, and hedged.
  assert.equal(f.confident, false, "with two in flight it must not claim certainty");
  assert.ok(f.alternatives.includes("slowThing"), "and must name the other candidate");
});

// --- a guess must not accuse a control ---------------------------------------

test("a hedged failure does not grade an innocent click as failed", () => {
  // The failure line names neither module nor method, so it is matched to the
  // nearest preceding dispatch. With a 2.5s crawl window and a 20s transport
  // timeout, that dispatch is routinely somebody else's. Reproduced before the
  // fix: a click whose own call SUCCEEDED was graded `failed`, with the name of
  // the call that succeeded given as the victim.
  const lines = [
    'LogosAPIClient: invoking remote method "mod" "slowThing" args_count: 0',
    '[LogosObject] RemoteLogosObject::callMethod "slowThing" args: 0',
    'LogosAPIClient: invoking remote method "mod" "fastThing" args_count: 0',
    '[LogosObject] RemoteLogosObject::callMethod "fastThing" args: 0',
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
  ];
  const r = graded({ window: win(lines) });
  assert.notEqual(r.outcome, "failed", "a guess must not accuse this control");
  assert.equal(r.outcome, "unclear", "but it must not read as clean either");
  assert.ok(
    r.evidence.some((e) => /\?/.test(e)),
    `the hedge must be visible in the evidence: ${JSON.stringify(r.evidence)}`,
  );
});

test("an unambiguous failure still fails the click", () => {
  const lines = [
    'LogosAPIClient: invoking remote method "mod" "doThing" args_count: 0',
    '[LogosObject] RemoteLogosObject::callMethod "doThing" args: 0',
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
  ];
  const r = graded({ window: win(lines) });
  assert.equal(r.outcome, "failed");
  assert.deepEqual(r.failedCalls, ["mod.doThing"]);
});

test("a caller can supply the failures its own window owns", () => {
  // What the crawl does: pair over the whole run, then hand each click only the
  // failures whose dispatch happened during it.
  const lines = [
    'LogosAPIClient: invoking remote method "mod" "other" args_count: 0',
    '[LogosObject] RemoteLogosObject::callMethod "other" args: 0',
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
  ];
  const none = graded({ window: win(lines), failures: [] });
  // The click did dispatch a call, so `ran` — but it owns no failure, so it is
  // not blamed for the one in its window.
  assert.equal(none.outcome, "ran");
  assert.deepEqual(none.failedCalls, []);
});

// --- which control the crawl is actually clicking ----------------------------

test("a caption cannot steal a button's identity, or its safety check", async () => {
  // Hand-rolled cards are a container plus a MouseArea, so every label inside
  // resolves to that one handler. Taking the first in document order gave the
  // control the caption's name — and the destructive guard tests the name. So
  // DESTRUCTIVE.test("Review the details below.") was false, the crawl pressed
  // Send, and the report named the caption. Reproduced before this fix.
  const { collectClickables, DESTRUCTIVE } = await import("../dist/commands/smoke.js");
  const { UiSnapshot } = await import("../dist/runner/snapshot.js");
  const tree = {
    id: "1", type: "QQuickItem", text: "", visible: true, enabled: true, children: [
      { id: "2", type: "Column_QMLTYPE_3", text: "", visible: true, enabled: true, children: [
        { id: "3", type: "Text_QMLTYPE_4", text: "Review the details below.", visible: true, enabled: true, children: [] },
        { id: "4", type: "Rectangle_QMLTYPE_5", text: "", visible: true, enabled: true, children: [
          { id: "5", type: "Text_QMLTYPE_4", text: "Send", visible: true, enabled: true, children: [] },
          { id: "6", type: "MouseArea_QMLTYPE_6", text: "", visible: true, enabled: true, children: [] },
        ]},
      ]},
    ],
  };
  const snap = await UiSnapshot.capture({ getTree: async () => ({ tree }) });
  const q = collectClickables(snap);
  assert.equal(q.length, 1, "one control, however many labels resolve to it");
  assert.equal(q[0].label, "Send", "the control is named by its own label, not by a nearby caption");
  assert.ok(
    [q[0].label, ...q[0].alsoLabelled].some((l) => DESTRUCTIVE.test(l)),
    "and every label resolving to it is considered by the safety check",
  );
});

test("a real message beside a control is not silently discarded", async () => {
  // The regression this replaced: marking every label resolving to a click
  // target as a control name stripped genuine app messages from the oracle. It
  // is now `ambiguous` — it drives no verdict, but it is not thrown away.
  const { UiSnapshot } = await import("../dist/runner/snapshot.js");
  const tree = {
    id: "1", type: "QQuickItem", text: "", visible: true, enabled: true, children: [
      { id: "2", type: "Column_QMLTYPE_3", text: "", visible: true, enabled: true, children: [
        { id: "3", type: "Text_QMLTYPE_4", text: "Transfer failed: insufficient funds", visible: true, enabled: true, children: [] },
        { id: "4", type: "MouseArea_QMLTYPE_5", text: "", visible: true, enabled: true, children: [] },
      ]},
    ],
  };
  const snap = await UiSnapshot.capture({ getTree: async () => ({ tree }) });
  const roles = Object.fromEntries(snap.labelsWithRole().map((r) => [r.text, r.role]));
  assert.equal(roles["Transfer failed: insufficient funds"], "ambiguous");

  // And a button's own nested label is still a control name.
  const btn = {
    id: "1", type: "QQuickItem", text: "", visible: true, enabled: true, children: [
      { id: "2", type: "Button_QMLTYPE_3", text: "", visible: true, enabled: true, children: [
        { id: "3", type: "Text_QMLTYPE_4", text: "Done", visible: true, enabled: true, children: [] },
      ]},
    ],
  };
  const b = await UiSnapshot.capture({ getTree: async () => ({ tree: btn }) });
  assert.equal(b.labelsWithRole().find((r) => r.text === "Done").role, "control");
});

// The toast filter dropped every fresh clickable whose chosen label matched a
// confirmation the click had just surfaced. That is right for "Wallet CLI path
// copied", which vanishes on its own — but a genuine hit area whose own label
// happens to read as a confirmation is still a control, and because `untested`
// is built only from targets that were QUEUED, such a control vanished from the
// report altogether. The crawl then read as a complete sweep when it was not.
test("a label that names its control is not mistaken for a toast", async () => {
  const { collectClickables } = await import("../dist/commands/smoke.js");
  const { UiSnapshot } = await import("../dist/runner/snapshot.js");

  // "Sent" is the Button's OWN nested label: it names the control.
  const named = {
    id: "1", type: "QQuickItem", text: "", visible: true, enabled: true, children: [
      { id: "2", type: "Button_QMLTYPE_3", text: "", visible: true, enabled: true, children: [
        { id: "3", type: "Text_QMLTYPE_4", text: "Sent", visible: true, enabled: true, children: [] },
      ]},
    ],
  };
  const a = collectClickables(await UiSnapshot.capture({ getTree: async () => ({ tree: named }) }));
  assert.equal(a.length, 1);
  assert.equal(a[0].label, "Sent");
  assert.equal(a[0].namedBy, "ancestor", "the label is inside the control, so it names it");

  // The same text sitting beside a MouseArea in an enclosing container names
  // nothing — that IS a toast, and dropping it is correct.
  const beside = {
    id: "1", type: "QQuickItem", text: "", visible: true, enabled: true, children: [
      { id: "2", type: "Column_QMLTYPE_3", text: "", visible: true, enabled: true, children: [
        { id: "3", type: "Text_QMLTYPE_4", text: "Sent", visible: true, enabled: true, children: [] },
        { id: "4", type: "MouseArea_QMLTYPE_5", text: "", visible: true, enabled: true, children: [] },
      ]},
    ],
  };
  const b = collectClickables(await UiSnapshot.capture({ getTree: async () => ({ tree: beside }) }));
  assert.equal(b.length, 1);
  assert.equal(b[0].namedBy, "container", "shared container only — this is the one the crawl may drop");
});

test("a control's own label wins over a caption for naming, and says so", async () => {
  const { collectClickables } = await import("../dist/commands/smoke.js");
  const { UiSnapshot } = await import("../dist/runner/snapshot.js");
  const tree = {
    id: "1", type: "QQuickItem", text: "", visible: true, enabled: true, children: [
      { id: "2", type: "Column_QMLTYPE_3", text: "", visible: true, enabled: true, children: [
        { id: "3", type: "Text_QMLTYPE_4", text: "Review the details below.", visible: true, enabled: true, children: [] },
        { id: "4", type: "Rectangle_QMLTYPE_5", text: "", visible: true, enabled: true, children: [
          { id: "5", type: "Text_QMLTYPE_4", text: "Send", visible: true, enabled: true, children: [] },
          { id: "6", type: "MouseArea_QMLTYPE_6", text: "", visible: true, enabled: true, children: [] },
        ]},
      ]},
    ],
  };
  const q = collectClickables(await UiSnapshot.capture({ getTree: async () => ({ tree }) }));
  assert.equal(q[0].label, "Send");
  // Both labels reach this control through an enclosing container, so neither
  // NAMES it in the self/ancestor sense — which is exactly why the crawl must
  // not treat "the label matched a toast" as proof that it is one.
  assert.equal(q[0].namedBy, "container");
  assert.deepEqual(q[0].alsoLabelled, ["Review the details below."]);
});
