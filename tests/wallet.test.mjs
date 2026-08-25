// Which wallet the app under test meets, and what happens when it is unlocked.
//
// The flag half of this module is pinned in tests/isolation.test.mjs: passing
// `--wallet-password` used to imply the real `$HOME`, so asking to unlock a
// wallet silently handed the app the developer's real data. Nothing reached the
// rest of the module. That matters because every caller believes it without
// checking: `session.unlockPlan` decides whether a password means anything from
// `needsPassword`, the run header prints `storePath` as the wallet it is about
// to drive, and `smoke`, `init` and `inspect` print unlockWallet's answer
// verbatim and then carry on testing. A wrong reason there is worse than a
// crash — the run stays green while the app sits on its lock screen.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectWalletProvider, homeAndWallet, unlockWallet } from "../dist/app/wallet.js";
import { InspectorError } from "../dist/inspector/protocol.js";

/**
 * A minimal DiscoveredApp. Detection reads the manifest and nothing else, so
 * the artifact need not exist.
 */
function app(name, { deps = [], type = "ui_qml", main } = {}) {
  const manifest = { name, type, dependencies: deps };
  if (main !== undefined) manifest.main = main;
  return { manifest, slot: type === "core" ? "modules" : "plugins", form: "dir", artifact: `/nowhere/${name}` };
}

/**
 * A $HOME this test owns.
 *
 * `os.homedir()` reads $HOME on POSIX, and the store lookup is a real
 * `fs.existsSync` against it — without this, `hasStore` would depend on whether
 * whoever runs the suite happens to have a Medusa wallet, and the store path
 * would be unassertable.
 */
function fakeHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sito-wallet-home-"));
  const before = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** An inspector that records what it was asked and answers with one reply. */
function fakeInspector(reply) {
  const calls = [];
  return {
    calls,
    async evaluate(expression, objectId) {
      calls.push({ expression, objectId });
      if (reply instanceof Error) throw reply;
      return { result: reply, undefined: false };
    },
  };
}

const MEDUSA = {
  module: "medusa_core",
  name: "Medusa",
  needsPassword: true,
  storePath: "/nowhere/medusa-wallet-home/storage.json",
  hasStore: true,
};

// --- which wallet the app depends on -----------------------------------------

test("a medusa app is pointed at medusa's own store, under the HOME the run will use", (t) => {
  const home = fakeHome(t);
  const store = path.join(home, ".local/share/medusa-wallet-home/storage.json");

  const p = detectWalletProvider(app("medusa_ui", { deps: ["medusa_core"] }), []);
  assert.equal(p.module, "medusa_core");
  assert.equal(p.name, "Medusa", "the header calls it by this name");
  assert.equal(p.needsPassword, true, "medusa is the one provider with an unlock verb, so it is the one that is asked");
  assert.equal(
    p.storePath,
    store,
    "the path README documents, resolved against $HOME — not against --user-dir, which does not re-root it",
  );
  assert.equal(p.hasStore, false, "this HOME has never run medusa");

  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(store, '{"accounts":[]}');
  assert.equal(
    detectWalletProvider(app("medusa_ui", { deps: ["medusa_core"] }), []).hasStore,
    true,
    "hasStore is read off the disk each time: it is the difference between 'your real wallet' and 'a fresh throwaway one'",
  );
});

test("the standard Logos wallet is found, and is never asked for a password", (t) => {
  const home = fakeHome(t);

  const p = detectWalletProvider(app("tip_jar", { deps: ["logos_wallet"] }), []);
  assert.equal(p.module, "logos_wallet");
  assert.equal(p.name, "Logos wallet (standard LEZ)");
  assert.equal(
    p.needsPassword,
    false,
    "its store is not encrypted; session.unlockPlan drops the password on this flag alone, and asking for one would be theatre",
  );
  assert.equal(p.storePath, path.join(home, ".local/share/logos-wallet-home"), "a directory, not medusa's storage.json");
  assert.equal(p.hasStore, false);
});

test("a wallet module staged alongside the app counts, even when the manifest never names it", (t) => {
  fakeHome(t);

  // A repo commonly carries the UI plugin and its core module side by side and
  // the plugin's built manifest declares no dependencies at all. Judging only
  // by `dependencies` there reported "no wallet", and the run then printed no
  // wallet line for an app that is entirely a wallet.
  const ui = app("medusa_ui");
  const p = detectWalletProvider(ui, [ui, app("medusa_core", { type: "core" })]);
  assert.equal(p?.module, "medusa_core", "the staged set is the other half of the question");
  assert.equal(p.needsPassword, true);
});

test("an app that touches no known wallet module has no provider", (t) => {
  fakeHome(t);

  const notes = app("notes_ui", { deps: ["logos_notifications"] });
  assert.equal(
    detectWalletProvider(notes, [notes, app("logos_notifications", { type: "core" })]),
    null,
    "sitometres knows two wallet modules and must not claim a third",
  );
});

test("only a pure-QML plugin reports a wallet, because only it has a logos bridge", (t) => {
  fakeHome(t);

  // Unlocking goes through `logos.callModule` in the app's own QML. A view
  // module runs in a spawned ui-host and has no such bridge, so reporting a
  // provider for it promises an unlock that cannot be performed.
  assert.equal(
    detectWalletProvider(app("medusa_ui", { deps: ["medusa_core"], main: { "linux-amd64-dev": "medusa_ui.so" } }), []),
    null,
    "a plugin backed by a shared library is not unlockable from here",
  );
  assert.equal(
    detectWalletProvider(app("medusa_core", { type: "core", deps: ["medusa_core"] }), []),
    null,
    "a headless core module has no UI at all",
  );
  assert.ok(
    detectWalletProvider(app("medusa_ui", { deps: ["medusa_core"], main: {} }), []),
    "an EMPTY main map is what a built pure-QML manifest looks like, and it is still pure QML",
  );
});

// --- unlocking through the app's own bridge -----------------------------------

test("the unlock runs in the app's QML root, and the password cannot escape its string", async () => {
  const insp = fakeInspector('{"ok":true}');

  const why = await unlockWallet(insp, "qml-root-7", MEDUSA, 'hunter"2');

  assert.equal(why, null, "a bridge that answers ok unlocked the wallet");
  assert.equal(insp.calls.length, 1);
  assert.equal(
    insp.calls[0].objectId,
    "qml-root-7",
    "`logos` is injected into the app's own root and exists nowhere else; evaluating globally cannot work",
  );
  assert.equal(
    insp.calls[0].expression,
    'JSON.stringify(logos.callModule("medusa_core", "unlock", ["hunter\\"2"]))',
    "the module name comes from the provider, and a quote in the password is escaped rather than closing the string",
  );
});

test("a payload that mentions both true and false is not read as a refusal", async () => {
  const why = await unlockWallet(fakeInspector('{"ok":true,"locked":false}'), "qml-root-1", MEDUSA, "hunter2");
  assert.equal(why, null, "the wallet is unlocked and says so; `false` belongs to another field");
});

test("a wrong password is reported as a refusal, never as an unlocked wallet", async () => {
  const why = await unlockWallet(fakeInspector('{"ok":false}'), "qml-root-1", MEDUSA, "wrong");
  assert.equal(
    why,
    "the wallet refused the password",
    "smoke prints this and keeps testing; returning null here turns a locked app into a green run",
  );
});

test("the module's own words are preferred to a generic refusal", async () => {
  // callModule hands its answer back JSON-encoded, and the module had already
  // encoded its own, so what arrives is a quoted string containing a quoted
  // string: "{\"error\":\"invalid password\"}". Read flat, the escaped keys
  // match nothing and the reason degrades to the generic line — or to nothing
  // at all when the payload carries no `false`.
  const doubled = '"{\\"ok\\":false,\\"error\\":\\"invalid password\\"}"';
  assert.equal(await unlockWallet(fakeInspector(doubled), "qml-root-1", MEDUSA, "wrong"), "invalid password");

  const twiceOver = JSON.stringify(doubled);
  assert.equal(
    await unlockWallet(fakeInspector(twiceOver), "qml-root-1", MEDUSA, "wrong"),
    "invalid password",
    "the bridge sometimes encodes it again on the way out",
  );

  const noFalse = '"{\\"error\\":\\"wallet is locked out for 30s\\"}"';
  assert.equal(
    await unlockWallet(fakeInspector(noFalse), "qml-root-1", MEDUSA, "hunter2"),
    "wallet is locked out for 30s",
    "an error with nothing falsy in it must not read as success",
  );
});

test("an answer that arrives as an object rather than a string is still read for its error", async () => {
  const why = await unlockWallet(
    fakeInspector({ error: "no wallet has been created yet" }),
    "qml-root-1",
    MEDUSA,
    "hunter2",
  );
  assert.equal(why, "no wallet has been created yet");
});

test("an error payload with no message still says the module refused", async () => {
  const why = await unlockWallet(fakeInspector('{"error":{"code":7}}'), "qml-root-1", MEDUSA, "hunter2");
  assert.equal(why, "the wallet module returned an error", "an unreadable error is still an error, not an unlock");
});

test("a UI with no logos bridge names the module that could not be reached", async () => {
  // What a view-module plugin, or an app whose QML root was resolved to the
  // wrong object, actually produces. The message has to name the module: the
  // remedy for "medusa_core could not be reached" is not the remedy for a
  // wrong password, and the caller prints nothing else.
  const insp = fakeInspector(
    new InspectorError("evaluate", "ReferenceError: logos is not defined", { expression: "…" }),
  );

  const why = await unlockWallet(insp, "qml-root-1", MEDUSA, "hunter2");

  assert.equal(
    why,
    "could not reach medusa_core through the app's logos bridge: " +
      "inspector evaluate failed: ReferenceError: logos is not defined",
  );
});

// --- which HOME, and whether there is a password at all -----------------------

test("an env var that is set but empty is not a password", () => {
  // tests/isolation.test.mjs owns the defect itself — a password used to select
  // the real $HOME. This is the neighbouring edge: `--wallet-password` falls
  // back to $SITOMETRES_WALLET_PASSWORD, and CI hands that variable through
  // from a secret, so an unset secret arrives as "" rather than as nothing.
  // That run must be indistinguishable from a run that asked for no unlock:
  // session.unlockPlan drops an empty password anyway, so carrying one here
  // would put `wallet` in the options for an unlock that never happens.
  assert.deepEqual(homeAndWallet(false, ""), {}, "the same as passing nothing");
  assert.deepEqual(
    homeAndWallet(true, ""),
    { realHome: true, wallet: { choice: "real" } },
    "--real-home still chooses the real wallet, with no password key invented for it",
  );
  assert.deepEqual(
    homeAndWallet(false, "hunter2"),
    { wallet: { choice: "fresh", password: "hunter2" } },
    "and a real password carries, still without realHome — the CLI Object.assigns this over the shared options",
  );
});
