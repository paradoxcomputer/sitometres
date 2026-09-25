// Functions the coverage gate found nothing executing them: not exotic, just
// off the path every other test happens to walk. Each test here exists
// because `npm run coverage` named the function, not because the behaviour
// looked interesting on its own — see scripts/coverage-gate.mjs for why a
// function nothing calls is a function nothing can regress safely.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readLoggingConfig } from "../dist/app/userdir.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sito-loggingcfg-"));
const writeConfig = (dir, body) => fs.writeFileSync(path.join(dir, "config.yaml"), body);

// --- readLoggingConfig: config.yaml's `logging:` block, as Basecamp 0.3.0 --
// resolves it (app/utils/LoggingConfig.cpp). Untouched by any test until now:
// every caller-supplied user-dir in the rest of the suite is a fresh temp dir
// with no config.yaml at all, so only the "no file" fast path ever ran.

test("no config.yaml at all is null, not an error", () => {
  const dir = tmp();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(readLoggingConfig(path.join(dir, "does", "not", "exist")), null);
});

test("no `logging:` key, or an explicitly empty one, reads as the defaults", (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  writeConfig(dir, "some_other_key: 1\n");
  assert.deepEqual(readLoggingConfig(dir), {
    path: path.join(dir, "config.yaml"),
    enabled: true,
    console: true,
    dir: path.join(dir, "logs"),
    file: "basecamp.log",
  });

  writeConfig(dir, "logging:\n");
  assert.deepEqual(
    readLoggingConfig(dir),
    { path: path.join(dir, "config.yaml"), enabled: true, console: true, dir: path.join(dir, "logs"), file: "basecamp.log" },
    "a `logging:` key with no value is the same as none at all",
  );

  writeConfig(dir, "");
  assert.deepEqual(
    readLoggingConfig(dir).enabled,
    true,
    "an empty file parses to no document, not a throw",
  );
});

test("a document Basecamp itself would refuse falls back to the defaults, with the reason attached", (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const defaults = { enabled: true, console: true, dir: path.join(dir, "logs"), file: "basecamp.log" };

  writeConfig(dir, "not: yaml: at: all: [[[");
  let cfg = readLoggingConfig(dir);
  assert.match(cfg.problem, /^not valid YAML \(/);
  assert.equal(cfg.enabled, defaults.enabled);
  assert.equal(cfg.dir, defaults.dir);

  writeConfig(dir, "- just\n- a\n- list\n");
  cfg = readLoggingConfig(dir);
  assert.equal(cfg.problem, "not a mapping at the top level");

  writeConfig(dir, "logging: [1, 2, 3]\n");
  cfg = readLoggingConfig(dir);
  assert.equal(cfg.problem, "`logging` is not a mapping");

  writeConfig(dir, "logging:\n  enabled: yes-please\n");
  cfg = readLoggingConfig(dir);
  assert.equal(cfg.problem, "`logging.enabled` and `logging.console` must be true or false");
  assert.equal(cfg.enabled, true, "the default is still returned alongside the problem");

  writeConfig(dir, 'logging:\n  file: "sub/dir/basecamp.log"\n');
  cfg = readLoggingConfig(dir);
  assert.match(cfg.problem, /^logging\.file must be a plain file name, not /);

  writeConfig(dir, 'logging:\n  file: "../escape.log"\n');
  cfg = readLoggingConfig(dir);
  assert.match(cfg.problem, /^logging\.file must be a plain file name/, "a traversal is refused the same as a path separator");
});

test("a well-formed logging block is read field by field, dir resolved absolute, relative and under ~", (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  writeConfig(dir, "logging:\n  enabled: false\n  console: false\n  dir: /custom/logs\n  file: my.log\n");
  assert.deepEqual(readLoggingConfig(dir), {
    path: path.join(dir, "config.yaml"),
    enabled: false,
    console: false,
    dir: "/custom/logs",
    file: "my.log",
  });

  writeConfig(dir, "logging:\n  dir: relative-logs\n");
  assert.equal(readLoggingConfig(dir).dir, path.join(dir, "relative-logs"), "relative to the user-dir, not to cwd");

  writeConfig(dir, "logging:\n  dir: ~/logos-logs\n");
  assert.equal(readLoggingConfig(dir).dir, path.join(os.homedir(), "logos-logs"));

  writeConfig(dir, "logging:\n  enabled: true\n");
  assert.equal(readLoggingConfig(dir).console, true, "console still defaults true when only enabled is given");
});
