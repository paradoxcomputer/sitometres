// Selector tests against a tree fixture mirroring the REAL tip_jar structure
// captured from the running app: the label lives on a QQuickText nested two
// levels inside Button_QMLTYPE_42, and the same words also appear in a
// subtitle and a hint that are not clickable.
import test from "node:test";
import assert from "node:assert/strict";

import { UiSnapshot } from "../dist/runner/snapshot.js";
import { resolveAll, resolveOne, normaliseText, toSelector } from "../dist/runner/selector.js";
import { runChecks } from "../dist/runner/assert.js";

const TREE = {
  id: "397", type: "QWidget", visible: true, enabled: true, children: [
    { id: "399", type: "QQuickWidget", visible: true, enabled: true, children: [
      { id: "400", type: "Main_QMLTYPE_112", visible: true, enabled: true, children: [
        { id: "401", type: "QQuickColumnLayout", visible: true, enabled: true, children: [
          { id: "413", type: "QQuickText", visible: true, text: "A “Connect with Medusa” SDK demo" },
          { id: "416", type: "QQuickText", visible: true, text: "Pick a chain, then tap “Connect with Medusa”." },
          { id: "424", type: "Button_QMLTYPE_42", visible: true, enabled: true, children: [
            { id: "426", type: "QQuickItem", visible: true, children: [
              { id: "427", type: "QQuickRow", visible: true, children: [
                { id: "429", type: "QQuickText", visible: true, text: "Connect with Medusa" },
              ] },
            ] },
          ] },
          { id: "430", type: "Button_QMLTYPE_42", visible: false, enabled: true, children: [
            { id: "431", type: "QQuickText", visible: false, text: "Disconnect" },
          ] },
          { id: "440", type: "LogosTextField_QMLTYPE_46", visible: true, enabled: true, objectName: "amountField", text: "" },
        ] },
      ] },
    ] },
  ],
};

const snap = await UiSnapshot.capture(
  { getTree: async () => ({ tree: TREE }) },
  undefined,
);

test("captures the whole tree with parent links", () => {
  assert.equal(snap.nodes.length, 13);
  const label = snap.nodes.find((n) => n.text === "Connect with Medusa");
  assert.ok(snap.ancestors(label).some((a) => a.id === "424"));
});

test("a label resolves to its clickable ancestor, not to the label itself", () => {
  const m = resolveOne(snap, "Connect with Medusa");
  assert.equal(m.target.id, "424");
  assert.equal(m.target.type, "Button_QMLTYPE_42");
  assert.equal(m.via, "ancestor");
});

test("the button beats the subtitle and the hint that contain the same words", () => {
  const all = resolveAll(snap, { text: "Connect with Medusa", match: "contains" });
  assert.equal(all[0].target.id, "424");
  assert.ok(all[0].score > all[1].score, "exact label on a clickable must outrank prose");
});

test("hidden controls are excluded by default and explained when asked for", () => {
  assert.equal(resolveAll(snap, { text: "Disconnect" }).length, 0);
  assert.equal(resolveAll(snap, { text: "Disconnect", includeHidden: true }).length, 1);
  // The useful answer is "it is there but not visible", not "no such label".
  assert.throws(() => resolveOne(snap, "Disconnect"), /carry that text but were excluded/);
  assert.throws(() => resolveOne(snap, "Disconnect"), /not visible/);
  assert.throws(() => resolveOne(snap, "Disconnect"), /needs a preceding step/);
});

test("a disabled-but-visible control is diagnosed as disabled, not as missing", () => {
  const disabledTree = {
    id: "1", type: "QWidget", visible: true, enabled: true, children: [
      { id: "2", type: "Button_QMLTYPE_9", visible: true, enabled: false, children: [
        { id: "3", type: "QQuickText", visible: true, text: "Send Tip" },
      ] },
    ],
  };
  return UiSnapshot.capture({ getTree: async () => ({ tree: disabledTree }) }).then((s2) => {
    assert.throws(() => resolveOne(s2, { text: "Send Tip", clickable: true }), /disabled/);
    assert.throws(() => resolveOne(s2, { text: "Send Tip", clickable: true }), /the app may still be busy/);
  });
});

test("a miss never suggests the exact string that was searched for", () => {
  // Suggesting "did you mean X?" when the user typed X is pure noise.
  try {
    resolveOne(snap, { text: "Disconnect", clickable: true });
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(!/Did you mean: "Disconnect"/.test(err.message), err.message);
  }
});

test("a near miss suggests the substring form rather than just failing", () => {
  assert.throws(
    () => resolveOne(snap, "Connect with"),
    /substring match would have found/,
  );
});

test("typographic characters do not have to be reproduced by hand", () => {
  assert.equal(normaliseText("A “Connect” demo…"), 'A "Connect" demo...');
  const m = resolveOne(snap, 'A "Connect with Medusa" SDK demo');
  assert.equal(m.node.id, "413");
});

test("regex selectors work", () => {
  const m = resolveOne(snap, { text: "/^Connect with/", match: "regex" });
  assert.equal(m.target.id, "424");
  assert.equal(toSelector("/x/").match, "regex");
});

test("objectName selects a field that has no visible label", () => {
  const m = resolveOne(snap, { objectName: "amountField" });
  assert.equal(m.node.id, "440");
});

test("clickable: true refuses inert text", () => {
  assert.throws(
    () => resolveOne(snap, { text: "Pick a chain, then tap “Connect with Medusa”.", clickable: true }),
    /no element matches/,
  );
});

// medusa_ui and zonescan_lite build essentially every control this way: the
// handler is a SIBLING of the label, not an ancestor. An ancestor-only search
// finds zero clickable controls in them.
const SIBLING_TREE = {
  id: "1", type: "QWidget", visible: true, enabled: true, children: [
    { id: "2", type: "QQuickWidget", visible: true, enabled: true, children: [
      { id: "10", type: "QQuickRectangle_QML_124", visible: true, enabled: true, children: [
        { id: "11", type: "QQuickText", visible: true, text: "Create wallet" },
        { id: "12", type: "QQuickMouseArea", visible: true, enabled: true },
      ] },
      { id: "20", type: "QQuickRectangle_QML_124", visible: true, enabled: true, children: [
        { id: "21", type: "QQuickText", visible: true, text: "Restore" },
        { id: "22", type: "QQuickMouseArea", visible: true, enabled: true },
      ] },
      { id: "30", type: "QQuickColumn", visible: true, enabled: true, children: [
        { id: "31", type: "QQuickPre64TextInput", visible: true, enabled: true, text: "" },
        { id: "32", type: "QQuickPre64TextInput", visible: true, enabled: true, text: "" },
        { id: "33", type: "QQuickMouseArea", visible: true, enabled: true },
      ] },
    ] },
  ],
};

const sib = await UiSnapshot.capture({ getTree: async () => ({ tree: SIBLING_TREE }) });

test("a label beside a MouseArea resolves to that MouseArea", () => {
  const m = resolveOne(sib, { text: "Create wallet", clickable: true });
  assert.equal(m.via, "hitArea");
  assert.equal(m.target.id, "12");
  assert.equal(m.target.type, "QQuickMouseArea");
});

test("each container's own handler is used, not a neighbour's", () => {
  assert.equal(resolveOne(sib, { text: "Create wallet", clickable: true }).target.id, "12");
  assert.equal(resolveOne(sib, { text: "Restore", clickable: true }).target.id, "22");
});

test("two fields sharing one container stay separately addressable", () => {
  // Deduping on the click target would merge them and make nth: 1 unreachable,
  // which is exactly the password / confirm-password case.
  const all = resolveAll(sib, { type: "Pre64TextInput", editable: true });
  assert.equal(all.length, 2);
  assert.equal(resolveOne(sib, { type: "Pre64TextInput", nth: 0, editable: true }).node.id, "31");
  assert.equal(resolveOne(sib, { type: "Pre64TextInput", nth: 1, editable: true }).node.id, "32");
});

test("labels() lists only what the user can see", () => {
  const labels = snap.labels();
  assert.ok(labels.includes("Connect with Medusa"));
  assert.ok(!labels.includes("Disconnect"));
  assert.ok(snap.labels(true).includes("Disconnect"));
});

// ---------------------------------------------------------------------------
// "Did you mean" — the last branch of the failing-selector path.
//
// Nothing above reaches it. Every miss in this file so far lands in an EARLIER
// branch of explainMiss: the label exists but is hidden, or a substring match
// would have found it. So `suggest`, the capped edit `distance` behind it, and
// assert.ts's `nearestLabels` shipped unexecuted — and they are the whole
// difference between a spec author finding their typo in five seconds and
// hunting for it in a tree of four hundred nodes.

test("a typo is answered with the label the author meant", () => {
  // Two transposed characters, so the substring branch cannot help and the
  // edit-distance guess is the only thing standing between the author and a
  // bare "no element matches". "Disconnect" also sits on a hidden button: the
  // guess deliberately searches those, because from the outside a mistyped
  // label and an unrevealed one look exactly the same.
  assert.ok(!snap.labels().includes("Disconnect"));
  try {
    resolveOne(snap, "Disconncet");
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(
      err.message,
      'no element matches text "Disconncet" (exact)\n  Did you mean: "Disconnect"?',
    );
  }
});

test("a label typed with extra words around it is still recognised", () => {
  // The substring branch only finds labels that CONTAIN what was typed, so
  // "Tap Disconnect now" falls past it; distance's containment shortcut is what
  // scores it 1 instead of the 8 plain Levenshtein would give — over the
  // tolerance for an 18-character needle, and no hint at all.
  try {
    resolveOne(snap, "Tap Disconnect now");
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(
      err.message,
      'no element matches text "Tap Disconnect now" (exact)\n  Did you mean: "Disconnect"?',
    );
  }
});

test("a label wholly unlike what was typed is not offered at all", () => {
  // The tolerance is a cap, not a ranking: past max(3, length/3) edits a label
  // is dropped rather than listed last. Offering the four nearest strings in the
  // tree no matter how far they are turns the hint into noise.
  try {
    resolveOne(snap, "Xylophone quarantine");
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(err.message, 'no element matches text "Xylophone quarantine" (exact)');
  }
});

// A transaction screen with two labels close to one typo and one far from it.
// "Resend" comes FIRST in the tree, so tree order and distance order disagree
// and the ordering assertion below is about ranking rather than about which
// nodes happened to match.
const TX_TREE = {
  id: "1", type: "QQuickWidget", visible: true, enabled: true, children: [
    { id: "2", type: "Button_QMLTYPE_7", visible: true, enabled: true, text: "Resend" },
    { id: "3", type: "Button_QMLTYPE_7", visible: true, enabled: true, text: "Send" },
    { id: "4", type: "QQuickText", visible: true, text: "Transaction history" },
  ],
};

const tx = await UiSnapshot.capture({ getTree: async () => ({ tree: TX_TREE }) });

test("suggestions are ordered by how far they are from what was typed", () => {
  // "Sent" is one edit from "Send" and three from "Resend"; "Transaction
  // history" is past the cap and must not appear at all.
  assert.deepEqual(tx.labels(true), ["Resend", "Send", "Transaction history"]);
  try {
    resolveOne(tx, "Sent");
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(
      err.message,
      'no element matches text "Sent" (exact)\n  Did you mean: "Send", "Resend"?',
    );
  }
});

test("two equally good matches are refused, and both are named", () => {
  // Picking the first of two identical Buttons would make `type:` selectors
  // silently positional — the step passes, and it clicked whichever one the
  // tree happened to list first.
  try {
    resolveOne(tx, { type: "Button" });
    assert.fail("should have thrown");
  } catch (err) {
    assert.equal(
      err.message,
      "type ~ Button is ambiguous — 2 equally good matches:\n" +
        '    [0] Button_QMLTYPE_7 "Resend"\n' +
        '    [1] Button_QMLTYPE_7 "Send"\n' +
        "  Narrow it with type:, objectName:, or nth:.",
    );
    // The candidates ride along so a report can render them without re-resolving.
    assert.deepEqual(err.candidates.map((m) => m.node.id), ["2", "3"]);
  }
  // And the indices in that listing are the ones nth: accepts.
  assert.equal(resolveOne(tx, { type: "Button", nth: 1 }).node.text, "Send");
});

// --- snapshot lookup by id --------------------------------------------------

test("byId finds the node the resolver targeted, and nothing else", () => {
  // Same object, not a copy: callers hold on to the result and read `enabled`
  // and `geometry` off it after the fact.
  assert.equal(snap.byId("424"), resolveOne(snap, "Connect with Medusa").target);
  // Ids are the inspector's, not positions in the tree: id "2" is the node at
  // index 1, and it is id "10" that sits at index 2.
  assert.equal(sib.byId("2").type, "QQuickWidget");
  assert.equal(sib.byId("2").index, 1);
  assert.equal(sib.byId("10").index, 2);
  assert.equal(sib.byId("12").type, "QQuickMouseArea");
});

test("an id from another capture resolves to nothing rather than to a neighbour", () => {
  // A snapshot is one instant of one app. Ids survive in specs and in a
  // caller's variables longer than the nodes do, so a stale one has to come
  // back undefined — a fallback to some other node would click a ghost.
  assert.equal(snap.byId("12"), undefined, '"12" exists only in the sibling fixture');
  assert.equal(snap.byId("999"), undefined);
  // And ids are compared whole: "42" is a prefix of the button's "424".
  assert.equal(snap.byId("42"), undefined);
});

// --- the same job, for a text expectation rather than a selector ------------
//
// A failing `text:` expectation reports which labels ARE there. Without it the
// step just says "sees X: fail", which is the least useful sentence a test
// runner can produce.

const WALLET_TREE = {
  id: "1", type: "QQuickWidget", visible: true, enabled: true, children: [
    { id: "2", type: "QQuickText", visible: true, text: "Balance: 12.5 LOG" },
    { id: "3", type: "Button_QMLTYPE_7", visible: true, enabled: true, children: [
      { id: "4", type: "QQuickText", visible: true, text: "Send" },
    ] },
    { id: "5", type: "QQuickText", visible: false, text: "Insufficient funds" },
  ],
};

const wallet = await UiSnapshot.capture({ getTree: async () => ({ tree: WALLET_TREE }) });

const assertCtx = (snapshot) => ({
  inspector: null,
  snapshot,
  window: [],
  qmlRootId: null,
  appName: "wallet_ui",
  logsUsable: false,
  ignoreCalls: [],
  cursor: 0,
});

const textCheck = async (snapshot, want) => {
  const checks = await runChecks(assertCtx(snapshot), { text: [want] });
  return checks.find((c) => c.kind === "text");
};

test("a text expectation that missed names the label that carries the words", async () => {
  // The commonest real miss by far: the app renders the value with the label,
  // and the spec asserted the bare prefix.
  const c = await textCheck(wallet, "Balance");
  assert.equal(c.verdict, "fail");
  assert.equal(c.detail, 'closest visible: "Balance: 12.5 LOG"');
});

test("it also matches the other way round, when the expectation is the longer string", async () => {
  const c = await textCheck(wallet, "Send it now");
  assert.equal(c.detail, 'closest visible: "Send"');
});

test("with nothing close it lists what is on screen, and only what is visible", async () => {
  assert.equal(
    (await textCheck(wallet, "Receive")).detail,
    'visible labels include: "Balance: 12.5 LOG", "Send"',
  );
  // "Insufficient funds" IS in this tree, on a hidden node — and it is the
  // nearest thing to what was asked for. Unlike a selector typo hint, this one
  // must not offer it: a text expectation is a claim about what the user can
  // see, and calling a hidden string the "closest visible" label tells the
  // author their assertion nearly held when it is nowhere on screen.
  assert.equal(
    (await textCheck(wallet, "Insufficient")).detail,
    'visible labels include: "Balance: 12.5 LOG", "Send"',
  );
});

test("an empty scope says so instead of listing nothing", async () => {
  // An empty list rendered as `visible labels include: ` reads as a formatting
  // bug; the honest answer is that the scope is empty, which is usually a wrong
  // `view:` or a dock that never loaded.
  const bare = await UiSnapshot.capture({ getTree: async () => ({ tree: { id: "1", type: "QQuickWidget", visible: true } }) });
  assert.deepEqual(bare.labels(), []);
  assert.equal((await textCheck(bare, "Anything")).detail, "nothing visible in scope");
});

test("a missed objectName expectation guesses no labels", async () => {
  // Nothing about the visible text is evidence for or against an objectName, so
  // there is nothing honest to add.
  const c = await textCheck(wallet, { objectName: "amountField" });
  assert.equal(c.verdict, "fail");
  assert.equal(c.detail, "");
});
