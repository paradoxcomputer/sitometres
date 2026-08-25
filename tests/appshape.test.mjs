// What the tool assumes about an app's layout and the machine it runs on.
import test from "node:test";
import assert from "node:assert/strict";

import { findQmlRoot } from "../dist/runner/open.js";
import { basecampUserDirs } from "../dist/session.js";
import { hostVariant } from "../dist/app/userdir.js";
import { runChecks } from "../dist/runner/assert.js";
import { doEval } from "../dist/runner/actions.js";

const dock = (...types) => ({
  id: "dock",
  type: "QQuickItem",
  children: types.map((t, i) => ({ id: `n${i}`, type: t, children: [] })),
});

test("the QML root is found from the view the manifest declares", () => {
  // Qt names the type after the file, so an app whose entry is App.qml has no
  // Main_QMLTYPE_ anywhere. Matching that name hardcoded a convention Basecamp
  // does not impose — it setSource()s whatever `view` says.
  const tree = dock("QQuickWidget", "App_QMLTYPE_42");
  assert.equal(findQmlRoot(tree, "qml/App.qml"), "n1");
  assert.equal(findQmlRoot(tree, "App.qml"), "n1");
});

test("Main.qml still works, as it always did", () => {
  const tree = dock("Main_QMLTYPE_7");
  assert.equal(findQmlRoot(tree, "qml/Main.qml"), "n0");
  assert.equal(findQmlRoot(tree, undefined), "n0", "and with no manifest to consult");
});

test("a differently-named root is still found when no view is known", () => {
  // The fallback: the dock holds one app, so any QML type in it is that app's.
  assert.equal(findQmlRoot(dock("QQuickWidget", "Dashboard_QMLTYPE_3"), undefined), "n1");
});

test("a dock with no QML type at all reports no root", () => {
  assert.equal(findQmlRoot(dock("QQuickWidget", "QQuickItem"), "qml/Main.qml"), null);
});

test("a view name with regex characters does not break the match", () => {
  assert.equal(findQmlRoot(dock("My_App_QMLTYPE_1"), "qml/My_App.qml"), "n0");
});

test("a state: check with no root says WHY it is inconclusive", async () => {
  const checks = await runChecks(
    {
      inspector: null,
      snapshot: { nodes: [], labels: () => [], clickTargetFor: (n) => ({ target: n, via: "self" }) },
      window: [],
      qmlRootId: null,
      appName: "a",
      logsUsable: false,
      ignoreCalls: [],
      cursor: 0,
    },
    { state: "root.ready" },
  );
  assert.equal(checks[0].verdict, "inconclusive");
  assert.match(checks[0].detail, /view/, "the detail must name the cause, not just the symptom");
  assert.match(checks[0].detail, /open:/);
});

test("eval with no root fails instead of running in global scope", async () => {
  // It used to evaluate globally and report the result as though it had worked.
  await assert.rejects(
    () => doEval({ inspector: { evaluate: async () => ({ result: 1 }) }, scopeId: null }, "root.x", null),
    /QML root was not found/,
  );
});

test("the Basecamp user-dir search knows this platform", () => {
  const dirs = basecampUserDirs();
  assert.ok(dirs.length > 0);
  const joined = dirs.join("\n");
  if (process.platform === "darwin") {
    assert.match(joined, /Library\/Application Support\/Logos/);
  } else {
    assert.match(joined, /\.local\/share\/Logos/);
  }
});

// Both branches, from either host. The version above asserts the LINUX list
// when it is not running on a Mac, so it would pass with the darwin code
// deleted — and CI is ubuntu-only, so nothing anywhere executed that branch,
// while openspec/specs/app-shape and an archived task both recorded it as
// regression-tested. The platform is a parameter now for exactly this reason.
test("the macOS user-dir list is the macOS one, wherever the test runs", () => {
  const dirs = basecampUserDirs("darwin", "/Users/someone");
  assert.deepEqual(dirs, [
    "/Users/someone/Library/Application Support/Logos/LogosBasecampDev",
    "/Users/someone/Library/Application Support/Logos/LogosBasecamp",
    // Kept for a developer who moved between platforms, or a shared checkout.
    "/Users/someone/.local/share/Logos/LogosBasecampDev",
    "/Users/someone/.local/share/Logos/LogosBasecamp",
  ]);
});

test("and the Linux list has no macOS paths in it", () => {
  const dirs = basecampUserDirs("linux", "/home/someone");
  assert.deepEqual(dirs, [
    "/home/someone/.local/share/Logos/LogosBasecampDev",
    "/home/someone/.local/share/Logos/LogosBasecamp",
  ]);
});

// hostVariant picks which tree to unpack out of a .lgx. Getting it wrong
// installs another platform's binaries, which fails later and somewhere else.
test("the .lgx variant is named for the platform, not for the host that asked", () => {
  assert.equal(hostVariant("darwin", "arm64"), "macos-arm64-dev");
  assert.equal(hostVariant("darwin", "x64"), "macos-amd64-dev");
  assert.equal(hostVariant("linux", "x64"), "linux-amd64-dev");
  assert.equal(hostVariant("win32", "x64"), "windows-amd64-dev");
  // An architecture with no alias passes through rather than being mangled.
  assert.equal(hostVariant("linux", "riscv64"), "linux-riscv64-dev");
});

test("$LOGOS_USER_DIR takes precedence", () => {
  const prev = process.env.LOGOS_USER_DIR;
  process.env.LOGOS_USER_DIR = "/tmp/some-user-dir";
  try {
    assert.equal(basecampUserDirs()[0], "/tmp/some-user-dir");
  } finally {
    if (prev === undefined) delete process.env.LOGOS_USER_DIR;
    else process.env.LOGOS_USER_DIR = prev;
  }
});
