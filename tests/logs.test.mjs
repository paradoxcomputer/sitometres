// Log pipeline tests. Every fixture line below is copied verbatim from
// ~/.local/share/Logos/LogosBasecampDev/logs — no invented log formats.
import test from "node:test";
import assert from "node:assert/strict";

import { LogBuffer } from "../dist/logs/buffer.js";
import { parseLine, pairFailures, attributeTo, callsIn, callName } from "../dist/logs/classify.js";
import { expandLine } from "../dist/logs/expand.js";
import { fixtureBuffer } from "./helpers/basecamp-logs.mjs";

const feed = (lines) => {
  const b = new LogBuffer();
  for (const l of lines) b.append(l, "stdout");
  return b.slice(0).map(parseLine);
};

test("classifies a real call trail", () => {
  const p = feed([
    'LogosAPIClient: invoking remote method "medusa_core" "getWalletState" args_count: 0',
    'LogosAPIConsumer: Calling invokeRemoteMethod: "medusa_core" "getWalletState" args_count: 0 timeout: 20000',
    '[LogosObject] RemoteLogosObject::callMethod "getWalletState" args: 0',
  ]);
  assert.equal(p[0].signal.kind, "call_started");
  assert.equal(p[0].signal.target, "medusa_core");
  assert.equal(p[0].signal.method, "getWalletState");
  assert.equal(p[1].signal.kind, "call_dispatched");
  assert.equal(p[1].signal.timeoutMs, 20000);
  assert.equal(p[2].signal.kind, "transport_call");
  assert.equal(p[2].signal.method, "getWalletState");
});

test("recovers the failing method name positionally", () => {
  // The failure line names neither module nor method; the transport line
  // immediately before it is the only place the method appears.
  const p = feed([
    'LogosAPIClient: invoking remote method "medusa_core" "getSequencerStatus" args_count: 0',
    '[LogosObject] RemoteLogosObject::callMethod "getSequencerStatus" args: 0',
    "RemoteLogosObject: callRemoteMethod failed or timed out: 1",
  ]);
  const paired = [...pairFailures(p).values()];
  assert.equal(paired.length, 1);
  assert.equal(paired[0].method, "getSequencerStatus");
  assert.equal(paired[0].module, "medusa_core");
});

test("a successful call produces no failure pairing", () => {
  const p = feed([
    'LogosAPIClient: invoking remote method "medusa_core" "listAccounts" args_count: 0',
    '[LogosObject] RemoteLogosObject::callMethod "listAccounts" args: 0',
  ]);
  assert.equal(pairFailures(p).size, 0);
});

test("splits QML errors from QML warnings", () => {
  const p = feed([
    "file:///home/u/.local/share/Logos/LogosBasecampDev/plugins/medusa_ui/qml/Main.qml:412: ReferenceError: index is not defined",
    "file:///home/u/.local/share/Logos/LogosBasecampDev/plugins/medusa_ui/qml/Main.qml:88: QML MouseArea: Detected anchors on an item that is managed by a layout",
  ]);
  assert.equal(p[0].signal.kind, "qml_error");
  assert.equal(p[0].signal.errorType, "ReferenceError");
  assert.equal(p[0].lineNo, undefined); // lineNo lives on the signal
  assert.equal(p[0].signal.lineNo, 412);
  assert.equal(p[0].isError, true);
  assert.equal(p[1].signal.kind, "qml_warning");
  assert.equal(p[1].isError, false);
});

test("attributes errors to the owning app, and Basecamp's own QML to basecamp", () => {
  const p = feed([
    "file:///home/u/.local/share/Logos/LogosBasecampDev/plugins/tip_jar/qml/Main.qml:12: TypeError: x",
    "qrc:/qt/qml/Basecamp/Sidebar/Basecamp/Sidebar/SidebarPanel.qml:13: TypeError: Cannot read property 'launcherApps' of null",
  ]);
  assert.equal(attributeTo(p[0]), "tip_jar");
  assert.equal(attributeTo(p[1]), "basecamp");
});

test("parses the structured module-host format", () => {
  const [p] = feed([
    "[2026-08-04 18:14:09.123] [info] [package_manager] [LogosProviderObject] LogosAPIProvider: successfully published \"pm\"",
  ]);
  assert.equal(p.module, "package_manager");
  assert.equal(p.level, "info");
  assert.ok(p.message.startsWith("[LogosProviderObject]"));
});

test("finds signals nested inside a structured prefix", () => {
  const [p] = feed([
    '[2026-08-04 18:14:09.123] [info] [capability_module] LogosAPIClient: invoking remote method "core" "ping" args_count: 1',
  ]);
  assert.equal(p.module, "capability_module");
  assert.equal(p.signal.kind, "call_started");
  assert.equal(p.signal.target, "core");
});

test("unpacks a ui-host envelope into individual lines", () => {
  const parts = expandLine(
    'ui-host [ "logos_wallet" ]: "ui-host: loaded plugin \\"logos_wallet\\"\\nLogosAPIClient: invoking remote method \\"w\\" \\"getStatus\\" args_count: 0"',
  );
  assert.equal(parts.length, 2);
  assert.equal(parts[0].viaUiHost, "logos_wallet");
  const p = parseLine({ seq: 0, atMs: 0, received: new Date(), text: parts[1].text, origin: "stdout" });
  assert.equal(p.signal.kind, "call_started");
  assert.equal(p.signal.method, "getStatus");
});

test("plain lines pass through the expander untouched", () => {
  const parts = expandLine("Logos Core started successfully!");
  assert.equal(parts.length, 1);
  assert.equal(parts[0].viaUiHost, undefined);
});

test("cursors bracket exactly the lines of one step", () => {
  const b = new LogBuffer();
  b.append("before", "stdout");
  const cursor = b.mark();
  b.append("during-1", "stdout");
  b.append("during-2", "stdout");
  const window = b.slice(cursor);
  assert.deepEqual(window.map((l) => l.text), ["during-1", "during-2"]);
});

test("waitFor resolves from lines that already arrived", async () => {
  const b = new LogBuffer();
  b.append("Logos Core started successfully!", "stdout");
  const line = await b.waitFor((l) => l.text.includes("Core started"), { timeoutMs: 50 });
  assert.ok(line);
});

test("waitFor wakes on a later line rather than polling to timeout", async () => {
  const b = new LogBuffer();
  const started = Date.now();
  const p = b.waitFor((l) => l.text === "arrived", { timeoutMs: 5000 });
  setTimeout(() => b.append("arrived", "stdout"), 30);
  await p;
  assert.ok(Date.now() - started < 1000, "should resolve on arrival, not on a poll tick");
});

test("closing the stream releases waiters instead of hanging", async () => {
  const b = new LogBuffer();
  const p = b.waitFor(() => false, { timeoutMs: 60_000 });
  b.close("Basecamp exited");
  await assert.rejects(p, /Basecamp exited/);
});

// --- 0.3.0's held calls: dispatched later, or never ---------------------

test("a held call that a later dispatch to the same module consumes drops out of callsIn, and pairFailures marks it dispatched", () => {
  // The three real shapes, in the order 0.3.0 really prints them: the hold
  // (module not reachable yet), the getToken that names the module for the
  // async dispatch that follows it, then the dispatch itself. Once the
  // dispatch lands, the earlier hold was not a call the app is still waiting
  // on — it is the SAME call, now under way — so callsIn must not report it
  // twice, and pairFailures must not treat it as still outstanding.
  const p = feed([
    'LogosAPIConsumer: \'"widget_mod"::""\' deferred pending the module becoming reachable',
    'LogosAPIClient: getToken for module: "widget_mod"',
    'LogosAPIConsumer: async calling via LogosObject::callMethodAsync "listWidgets"',
  ]);

  const calls = callsIn(p);
  assert.deepEqual(calls.map(callName), ["widget_mod.listWidgets"], "the held placeholder is consumed, not reported alongside the real dispatch");
  assert.equal(calls[0].held, undefined, "the surviving entry is the dispatch, not the hold");

  // A held call that WAS dispatched must not also register as still-held-and-
  // now-unreachable if 0.3.0's 60s warning fires later for the same module.
  assert.equal(pairFailures(p).size, 0, "nothing failed here — the hold resolved into a normal dispatch");
});

test("acquire-fail-sync.v030.log: the one call in flight is named with confidence", () => {
  // Real corpus fixture, never driven through pairFailures until now: a
  // synchronous call to a module whose replica is never acquired. Exactly one
  // call was in flight, so the pairing names it outright instead of hedging
  // with alternatives.
  const p = fixtureBuffer("acquire-fail-sync.v030.log").slice(0).map(parseLine);
  const paired = [...pairFailures(p).values()];
  assert.equal(paired.length, 1, JSON.stringify(paired));
  assert.equal(paired[0].method, "x");
  assert.equal(paired[0].module, "no_such_module_xyz");
  assert.equal(paired[0].confident, true);
  assert.deepEqual(paired[0].alternatives, []);
});

test("acquire-fail-stale-handle.v030.log: a re-acquired handle still pairs to the call that was in flight", () => {
  const p = fixtureBuffer("acquire-fail-stale-handle.v030.log").slice(0).map(parseLine);
  const paired = [...pairFailures(p).values()];
  assert.ok(paired.length >= 1, JSON.stringify(paired));
  assert.equal(paired[0].method, "listRepositories");
  assert.equal(paired[0].module, "package_downloader");
});

test("held-async-unreachable.v030.log: a held call that never dispatched is named, not lost", () => {
  // Real corpus fixture: the hold fires, then the 3s warning that it is still
  // not reachable. No dispatch ever follows, so this is failure — unlike the
  // synthetic case above where a dispatch resolved the hold.
  const p = fixtureBuffer("held-async-unreachable.v030.log").slice(0).map(parseLine);
  const paired = [...pairFailures(p).values()];
  assert.equal(paired.length, 1, JSON.stringify(paired));
  assert.equal(paired[0].module, "no_such_module_sito");
  assert.equal(paired[0].method, "?", "only the module survives a call that was never dispatched");
  assert.equal(paired[0].confident, true);

  const calls = callsIn(p);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].held, true, "callsIn still reports it — held, and honestly labelled so");
});
