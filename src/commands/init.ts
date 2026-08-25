// ---------------------------------------------------------------------------
// `sitometres init` — write a starter spec for the app in this directory,
// pre-filled with controls the app actually has.
//
// Generated from a live snapshot rather than a template, so the labels are the
// real ones — including the curly quotes and ellipses that make hand-written
// expectations fail.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { uiLabel } from "../app/manifest.js";
import { boot, type BootOptions, type CommandDeps, REAL_DEPS } from "../session.js";
import { openApp, openOptionsFor, OpenError } from "../runner/open.js";
import { isClickableType, UiSnapshot } from "../runner/snapshot.js";
import { resolveSetupSpec, runSetupProfile } from "../runner/setup.js";
import { unlockWallet } from "../app/wallet.js";
import { explainOpenFailure, parseLine } from "../logs/classify.js";

export interface InitOptions extends BootOptions {
  out?: string;
  force?: boolean;
  /** A setup profile to run before snapshotting, so a gate is not what gets scaffolded. */
  setup?: string;
  noSetup?: boolean;
}

export async function init(opts: InitOptions = {}, deps: CommandDeps = REAL_DEPS): Promise<number> {
  const out = path.resolve(opts.out ?? "sitometres.yaml");
  if (fs.existsSync(out) && !opts.force) {
    console.error(`  ${out} already exists. Pass --force to overwrite.`);
    return 1;
  }

  const b = await deps.boot(opts);
  try {
    const app = b.app;
    if (!app) {
      console.error("  init needs a discoverable app; attach mode cannot stage one.");
      return 1;
    }
    const name = app.manifest.name;
    const label = uiLabel(app.manifest);

    let scope;
    try {
      scope = await openApp(
        b.session.inspector,
        name,
        label,
        openOptionsFor(b.app, b.userDir?.root, name, opts.timeoutMs),
      );
    } catch (err) {
      // init and inspect swallowed the hint, so the one command whose whole job
      // is to look at the app said only "did not open" when the log knew why.
      const e = err as OpenError;
      console.error(`  ${e.message}`);
      const why = explainOpenFailure(b.session.logs.slice(0).map(parseLine), name);
      if (why) for (const l of why.split("\n")) console.error(`    ${l}`);
      else if (e.hint) console.error(`    ${e.hint}`);
      return 1;
    }
    const scopeId = scope.scopeId;

    // Unlock, then walk the gate, then look. `init` is the documented first
    // step of the init -> run workflow, and against a gated app it used to
    // scaffold a spec from the unlock dialog's controls rather than the app's —
    // a starter spec that then failed for a reason the tool already knew. It
    // accepted `--wallet-password` and read it nowhere.
    if (b.walletUnlock && scope.qmlRootId) {
      const why = await unlockWallet(
        b.session.inspector,
        scope.qmlRootId,
        b.walletUnlock.provider,
        b.walletUnlock.password,
      );
      if (why) console.error(`  could not unlock the wallet: ${why}`);
    }
    await runSetupProfile(
      b,
      resolveSetupSpec(opts, name, b.app?.artifact ?? null),
      name,
      "starter spec",
    );

    const snap = await UiSnapshot.capture(b.session.inspector, scopeId);

    const buttons: string[] = [];
    const seen = new Set<string>();
    for (const node of snap.nodes) {
      if (!node.text || !node.visible) continue;
      const { target, via } = snap.clickTargetFor(node);
      if ((via !== "hitArea" && !isClickableType(target.type)) || seen.has(target.id)) continue;
      seen.add(target.id);
      buttons.push(node.text);
    }
    const headings = snap.labels().filter((l) => !buttons.includes(l)).slice(0, 3);

    fs.writeFileSync(out, template(name, label, app.manifest.dependencies, buttons, headings, b.fidelity.fidelity === "quiet"));
    console.log(`\n  wrote ${out}`);
    console.log(`  ${buttons.length} control(s) found in ${name}. Run it with:\n`);
    // A relative path that climbs out of the tree is worse than an absolute one.
    const rel = path.relative(process.cwd(), out);
    console.log(`      sitometres run ${rel.startsWith("..") ? out : rel}\n`);
    return 0;
  } finally {
    await b.dispose();
  }
}

/**
 * The spec `init` writes.
 *
 * Exported so the generated YAML can be parsed back in a test without
 * launching Basecamp — the unquoted-interpolation bugs shipped precisely
 * because nothing ever read this output.
 */
export function template(
  name: string,
  label: string,
  deps: string[],
  buttons: string[],
  headings: string[],
  quiet: boolean,
): string {
  const dep = deps[0];
  const first = buttons[0];
  const lines: string[] = [
    `# sitometres spec for ${name}`,
    `#`,
    `# Run:  sitometres run ${path.basename("sitometres.yaml")}`,
    `# Docs: every step performs one gesture, then checks what it caused.`,
    ``,
    `app: ${yamlStr(name)}`,
    ...(deps.length ? [`with: [${deps.map(yamlStr).join(", ")}]`] : []),
    // Above the transport's own 20 s reply timeout; at 15 s a call that timed
    // out could not be seen to have timed out, and the open could not finish.
    `timeout: 30s`,
    ``,
    `steps:`,
    `  - name: the app opens`,
    `    open: ${yamlStr(label)}`,
    `    expect:`,
    `      text:`,
    ...(headings.length
      ? headings.map((h) => `        - ${yamlStr(h)}`)
      : [`        - ${yamlStr(label)}   # a label that is visible once it has loaded`]),
    ``,
  ];

  if (first) {
    lines.push(
      `  - name: ${yamlStr(`${first.toLowerCase()} works`)}`,
      `    click: ${yamlStr(first)}`,
      `    expect:`,
      `      # As generated this asserts only that the control resolves, the click`,
      `      # lands, and the app does not throw — a real check, but a weak one.`,
      `      # Fill in what SHOULD happen; a spec is worth what its assertions say.`,
      `      # text: ["what the user should now see"]`,
      `      # A QML expression evaluated inside your app. Works on every build,`,
      `      # unlike log-based checks - prefer this for anything load-bearing.`,
      `      # state: "root.someProperty === 'expected'"`,
    );
    if (dep) {
      lines.push(
        `      # Backend calls this click must make, proven from the log. Run`,
        `      # \`sitometres ${name}\` to see which ones it actually makes.`,
        `      # calls: ["${dep}.someMethod"]`,
      );
    }
    lines.push("");
  }

  if (quiet) {
    lines.push(
      `# NOTE: the Basecamp binary found on this machine emits no Qt logging, so`,
      `# \`calls:\` assertions cannot be verified and will report INCONCLUSIVE.`,
      `# Use \`state:\` for proof, or test against a Basecamp built with logging on.`,
      ``,
    );
  }

  if (buttons.length > 1) {
    lines.push(`# Other controls sitometres found in ${name}:`);
    for (const b of buttons.slice(1, 12)) lines.push(`#   click: ${yamlStr(b)}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Quote defensively: real labels contain colons, quotes, emoji and ellipses. */
/**
 * A YAML scalar that means exactly the string given.
 *
 * JSON.stringify is a valid YAML double-quoted scalar, so this is correct
 * wherever it is used — the bug was the places that did NOT use it. Two
 * interpolations went in raw: the app's own display_name and a live control
 * label. A label containing ": " ends the key; one starting @, `-`, *, [ is a
 * parse error; one starting # silently truncates the value to null and one
 * starting ! is read as a tag, yielding the wrong name. `init` then printed
 * "Run it with: sitometres run sitometres.yaml" and that command failed.
 */
function yamlStr(s: string): string {
  return JSON.stringify(s);
}
