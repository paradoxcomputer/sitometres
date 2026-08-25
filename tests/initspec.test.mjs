// The spec `init` writes must be a spec `run` can read.
//
// Two interpolations went into the generated YAML unquoted: the app's own
// display_name and a live control label. `init` then printed "Run it with:
// sitometres run sitometres.yaml" and that command failed — or, worse, quietly
// parsed to the wrong thing.
import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";

import { validateSpec } from "../dist/spec/schema.js";
import { template } from "../dist/commands/init.js";

const manifest = (over = {}) => ({
  name: "my_app",
  type: "ui_qml",
  dependencies: [],
  ...over,
});

/** Labels that broke the generator, and how. */
const HOSTILE = [
  ["Send: now", "a colon-space ends the key"],
  ["@mention", "@ is a reserved indicator"],
  ["- dash", "reads as a nested sequence"],
  ["*star", "reads as an alias"],
  ["[bracket", "starts a flow sequence"],
  ["#hash", "silently truncated the value to null"],
  ["!bang", "read as a tag, yielding the wrong name"],
  ['quote"inside', "an embedded quote"],
  ["ünïcode ✓", "non-ASCII"],
  ["Loading…", "the typographic ellipsis the selector normalises"],
];

for (const [label, why] of HOSTILE) {
  test(`init writes a parseable spec for a label with ${why}`, () => {
    const text = template("my_app", label, [], [label], [label], true);
    let parsed;
    assert.doesNotThrow(() => {
      parsed = parse(text);
    }, `the generated YAML must parse: ${JSON.stringify(label)}`);

    const spec = validateSpec(parsed);
    assert.equal(spec.steps[0].open, label, "the open target must survive verbatim");
    assert.equal(spec.app, "my_app");
  });
}

test("a dependency list is quoted too", () => {
  const text = template("my_app", "My App", ["a: b", "plain_core"], [], [], true);
  const spec = validateSpec(parse(text));
  assert.deepEqual(spec.with, ["a: b", "plain_core"]);
});

test("an ordinary app is unchanged", () => {
  const text = template("my_app", "ZoneScan Lite", [], ["zonescan"], ["L1 BLOCK HEIGHT"], true);
  const spec = validateSpec(parse(text));
  assert.equal(spec.app, "my_app");
  assert.equal(spec.steps[0].open, "ZoneScan Lite");
});
