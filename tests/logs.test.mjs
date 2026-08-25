// Log pipeline tests. Every fixture line below is copied verbatim from
// ~/.local/share/Logos/LogosBasecampDev/logs — no invented log formats.
import test from "node:test";
import assert from "node:assert/strict";

import { LogBuffer } from "../dist/logs/buffer.js";
import { parseLine, pairFailures, attributeTo } from "../dist/logs/classify.js";
import { expandLine } from "../dist/logs/expand.js";

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
