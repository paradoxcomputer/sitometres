// ---------------------------------------------------------------------------
// `sitometres smoke` — a real UI test with no spec written.
//
// Stage the app, launch Basecamp, open it, then click every visible control in
// turn and record what each click actually did: which backend calls it fired,
// whether any of them failed, what new text appeared, and whether the app
// threw. It is exploratory rather than prescriptive — the pass condition is
// "nothing broke", not "the right thing happened" — but it catches the two
// failures that matter most on day one: the app does not load, and a control
// does nothing at all.
//
// A dead control is worth naming explicitly. If a click produces no backend
// call, no new text and no state change, the handler is very likely not wired
// up, and that is invisible to a test that only asserts on labels.
// ---------------------------------------------------------------------------

import { sleep } from "../inspector/client.js";
import { callName, callsIn, explainOpenFailure, parseLine, pairFailures, type PairedFailure, UNATTRIBUTED } from "../logs/classify.js";
import { boot, type BootOptions, type CommandDeps, REAL_DEPS } from "../session.js";
import type { InspectorClient } from "../inspector/client.js";
import { normaliseText } from "../runner/selector.js";
import { isClickableType, UiSnapshot } from "../runner/snapshot.js";
import { openApp, openOptionsFor, OpenError } from "../runner/open.js";
import { unlockWallet } from "../app/wallet.js";
import { classifyOutcome, describeOutcome, type Outcome } from "../runner/outcome.js";
import { suppressedBy } from "../runner/assert.js";
import { printHeader } from "../report/terminal.js";
import { defaultReportPath, printReport, type RunReport, writeReport } from "../report/runreport.js";
import { status } from "../report/status.js";
import fs from "node:fs";
import path from "node:path";

import { uiLabel } from "../app/manifest.js";
import { findSetupSpec, profilesDir, resolveSetupSpec, runSetupProfile } from "../runner/setup.js";
import type { FidelityReport } from "../runner/fidelity.js";
import { crawlToMachineReport, type MachineReport, toJson, toJUnit } from "../report/machine.js";
import { VERSION } from "../version.js";

// The same rule every other reporter here follows. The crawl painted its lines
// unconditionally, so `sitometres my_app > run.log` and NO_COLOR=1 both produced
// escape codes in the click lines and none in the table beneath them — one
// command, two answers to the same question.
const colour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const DIM = colour ? "\x1b[2m" : "";
const RST = colour ? "\x1b[0m" : "";
const GRN = colour ? "\x1b[32m" : "";
const RED = colour ? "\x1b[31m" : "";
const YEL = colour ? "\x1b[33m" : "";

export interface SmokeOptions extends BootOptions {
  /**
   * A spec to run BEFORE crawling, to get the app into a testable state.
   *
   * Most apps hide almost everything behind a gate: medusa_ui opens on
   * "Create your wallet" and nothing else exists until one is made, so a crawl
   * of the front door is a crawl of four controls. A setup spec walks through
   * the gate; the crawl then explores what is behind it.
   */
  setup?: string;
  /** Skip an auto-discovered setup spec. */
  noSetup?: boolean;
  /** Where to write the JSON report. Defaults to .sitometres/<app>.json. */
  report?: string;
  /** Skip writing a report file. */
  noReport?: boolean;
  /** Stop after this many controls. Default 12. */
  limit?: number;
  /** Milliseconds to observe after each click. Default 2500. */
  settleMs?: number;
  /** Labels to leave alone, e.g. anything destructive. */
  skip?: string[];
  /** Write a JUnit file, so the zero-configuration command can gate CI. */
  junit?: string;
  /** Write the machine-readable run report. */
  json?: string;
  /** Make an outcome that proves nothing fail the build. */
  strict?: boolean;
  /**
   * Backend calls to disregard when grading a click, e.g. a polling loop.
   *
   * Merged with whatever the app's setup profile declares.
   */
  ignoreCalls?: string[];
}

export interface SmokeClick {
  label: string;
  type: string;
  outcome: Outcome;
  evidence: string[];
  calls: string[];
  failedCalls: string[];
  newLabels: string[];
  errors: string[];
  reachedBy: string;
}

/** One click's evidence window, as the late-failure sweep sees it. */
export interface ClickWindow {
  label: string;
  from: number;
  to: number;
}

/**
 * Failures that no click's own grading accounted for.
 *
 * Extracted from the crawl body, and exported, because this is where the
 * shipped CI-gate regression of commit 73b8008 actually lived and NOTHING
 * could reach it: no test calls `smoke()`, so the sweep was verified only by a
 * regex over the source text of this file. The rule it encodes is worth stating
 * on its own — a failure is already accounted for ONLY if the click that
 * dispatched it also SAW it fail, i.e. the dispatch and the failure line fell
 * inside one window. Testing the anchor alone dropped every timeout, because
 * the transport gives up at 20 s and a click is watched for 2.5 s, so the
 * failure line is always in a later window or in none.
 */
export function reconcileLateFailures(
  paired: Iterable<[number, PairedFailure]>,
  windows: ClickWindow[],
  ignoreCalls: string[],
): string[] {
  const out: string[] = [];
  for (const [seq, f] of paired) {
    if (suppressedBy(f, ignoreCalls)) continue;
    const home = windows.find((w) => f.anchorSeq !== undefined && f.anchorSeq >= w.from && f.anchorSeq < w.to);
    const alreadyGraded = home !== undefined && seq >= home.from && seq < home.to;
    if (alreadyGraded) continue;
    const name = f.method === UNATTRIBUTED ? "a call" : `${f.module ?? "?"}.${f.method}`;
    out.push(home ? `${name} (dispatched by ${JSON.stringify(short(home.label))})` : name);
  }
  return out;
}

/**
 * Did this crawl observe anything at all?
 *
 * `--strict` is about the RUN proving nothing, not about individual controls
 * being unclear: `unclear` is the normal outcome for most controls in a real
 * app, and failing on it made --strict fail every healthy crawl.
 */
export function crawlProvedNothing(results: Array<{ outcome: Outcome; calls: string[] }>): boolean {
  return results.length === 0 || !results.some((r) => r.outcome === "worked" || r.calls.length > 0);
}

/**
 * The crawl's exit code, as one expression.
 *
 * Exported so the gate can be tested without a Basecamp. It was computed inline
 * in an un-exported async function, which is how it came to be wrong twice: once
 * exiting 0 on an app whose backend call failed, and once failing every healthy
 * crawl under `--strict`.
 */
export function crawlExitCode(input: {
  problems: number;
  strict?: boolean;
  provedNothing: boolean;
  evidenceUnreadable: boolean;
}): number {
  if (input.problems > 0) return 1;
  if (input.strict === true && (input.provedNothing || input.evidenceUnreadable)) return 1;
  return 0;
}

/**
 * Labels the crawler will not click.
 *
 * smoke runs against a throwaway user-dir, so local state is safe — but a
 * wallet or messaging app talks to the outside world, and a synthesised click
 * on "Send" can move real funds. The list therefore covers value transfer and
 * secret disclosure as well as destruction. It is a heuristic on visible text:
 * an unlabelled or oddly-worded button will still be clicked, so treat `smoke`
 * as something to point at a testnet, and use `--skip` for anything it misses.
 */
/**
 * Labels that take you back where you came from.
 *
 * The crawl navigates, and a control queued on a previous screen is stranded
 * once it does. Backtracking is not app-specific after all: a back affordance
 * is close to universal, and the crawl was already clicking medusa's own "←"
 * as one of its targets. Trying one before declaring a control unreachable
 * turns a 3-of-8 run into a real sweep.
 */
export const BACK = /^\s*(←|‹|◀|<|«|✕|×|⨯|✖|back|go back|close|dismiss|done)\s*$/i;

/**
 * A label long enough to be data rather than a name — a filesystem path, a
 * hash, an address. They are poor crawl targets and worse selectors, so they
 * are visited last and shown truncated.
 */
const MAX_LABEL = 42;

export function looksLikeData(label: string): boolean {
  return label.length > MAX_LABEL || /^[/~]|^0x[0-9a-f]{8}|^[A-Za-z]:\\/.test(label);
}

function short(label: string): string {
  if (label.length <= MAX_LABEL) return label;
  return label.slice(0, MAX_LABEL - 1) + "…";
}

/**
 * Replace this run's throwaway paths with stable placeholders.
 *
 * An app that displays a path shows OUR sandbox — "/tmp/sitometres-home-FLa4g8/
 * .local/bin/medusa-wallet" — which changes every run, so a report written for
 * diffing would differ every time for no reason. Applied to the recorded label
 * as well as the printed one, so the console and the JSON agree.
 */
function stable(text: string, sandboxHome: string | null, userDir: string | null): string {
  let out = text;
  // Braces, not angle brackets: the report strips markup for display, and
  // "<home>" is indistinguishable from an HTML tag — it was being deleted.
  if (sandboxHome) out = out.split(sandboxHome).join("{home}");
  if (userDir) out = out.split(userDir).join("{user-dir}");
  return out.replace(/\/tmp\/sitometres-(home-)?[A-Za-z0-9]+/g, (m) => (m.includes("home-") ? "{home}" : "{user-dir}"));
}

/** Longer budget for an evidence line, which is a sentence rather than a name. */
function short2(s: string): string {
  return s.length <= 96 ? s : s.slice(0, 95) + "…";
}

/**
 * Calls to disregard when grading a click.
 *
 * Empty, and it must stay empty. This used to be
 * ["medusa_core.pendingRequests", "medusa_core.getJob"] — two literal method
 * names from one app, compiled into a tool meant for anyone's module. For
 * every other author it broke the crawl's headline value: a background call
 * landing inside the settle window makes an inert control report `ran`, so
 * dead-control detection stopped working. Worse, matching is by suffix, so
 * `medusa_core.getJob` also suppressed a genuine timeout of ANY module's
 * `getJob`. An author knows their own poll; they declare it with
 * --ignore-calls or `ignore_calls:` in their setup profile.
 */
export const NOISY_CALLS: string[] = [];

// Setup profiles moved to ../runner/setup.ts so every verb that opens an app
// can use them, not just the crawl. Re-exported because these two names are the
// crawl's published surface and are what the suite imports.
export { findSetupSpec, profilesDir };

export const DESTRUCTIVE = new RegExp(
  "\\b(" +
    // destructive
    "delete|remove|reset|uninstall|wipe|destroy|erase|revoke|clear all|log ?out|sign ?out|quit|exit|shut ?down" +
    // moves value
    "|send|transfer|pay|tip|withdraw|swap|buy|sell|stake|mint|burn|approve|confirm|sign|broadcast|submit|purchase|subscribe" +
    // discloses secrets or changes what is installed
    "|export|reveal|backup|import|publish|deploy" +
  ")\\b",
  "i",
);

export async function smoke(opts: SmokeOptions = {}, deps: CommandDeps = REAL_DEPS): Promise<number> {
  const limit = opts.limit ?? 12;
  const settleMs = opts.settleMs ?? 2500;
  const t0 = Date.now();
  // boot() can throw — no Basecamp, no app, staging refused — and until now
  // that produced no artifact at all: a CI job that asked for --junit got exit
  // 1 and no file, which every publisher reports as "no test results",
  // indistinguishable from never having run.
  let b: Awaited<ReturnType<typeof boot>>;
  try {
    b = await deps.boot(opts);
  } catch (err) {
    emitArtifacts(
      opts,
      stillbornReport(null, "(not started)", QUIET_FIDELITY, Date.now() - t0,
        "start a run", "fail", (err as Error).message),
    );
    throw err;
  }
  let problems = 0;
  const startedAt = new Date().toISOString();

  try {
    const app = b.app;
    const appName = app?.manifest.name ?? null;

    printHeader({
      app: appName ?? "(attached)",
      appType: app?.manifest.type ?? "unknown",
      dependencies: app?.manifest.dependencies ?? [],
      basecamp: b.basecamp?.path ?? "(attached)",
      userDir: b.userDir?.root ?? "(attached)",
      sandboxHome: b.sandboxHome,
      attached: b.basecamp === null,
      ...(b.userDir?.foreign.length ? { foreignApps: b.userDir.foreign } : {}),
      ...(b.userDir?.replaced.length ? { replacedApps: b.userDir.replaced } : {}),
      ...(b.userDir?.restores ? { restoresUserDir: true } : {}),
      ...(b.userDir?.inPlace.length ? { inPlaceApps: b.userDir.inPlace } : {}),
      ...(b.walletUnlock ? { walletUnlocked: true } : {}),
      logSource: b.session.logSource.describe(),
      fidelity: b.fidelity,
      headless: opts.headless !== false,
      inspectorPort: b.session.port,
      ...(b.walletSummary ? { wallet: b.walletSummary } : {}),
      ...(b.app ? { source: { origin: b.app.origin, form: b.app.form, builtAt: b.app.builtAt, ...(b.app.manifest.version ? { version: b.app.manifest.version } : {}) } } : {}),
    });

    if (!appName) {
      console.log(`  ${RED}x${RST} smoke needs an app to open; attach mode cannot stage one\n`);
      emitArtifacts(
        opts,
        stillbornReport(null, b.basecamp?.path ?? "(attached)", b.fidelity, Date.now() - t0,
          "open the app under test", "fail",
          "smoke needs an app to open; attach mode cannot stage one"),
      );
      return 1;
    }

    // --- what counts as noise ---------------------------------------------
    //
    // Resolved BEFORE the open step, because the open step's evidence is
    // graded too: a poll that fires while the dock is being built would
    // otherwise fail the launch of an app that is fine.
    const resolvedSetup = resolveSetupSpec(opts, appName, b.app?.artifact ?? null);
    const setupFile = resolvedSetup?.file ?? null;
    const ignoreCalls = [
      ...NOISY_CALLS,
      ...(opts.ignoreCalls ?? []),
      ...(resolvedSetup?.spec.ignoreCalls ?? []),
    ];

    // --- open it ----------------------------------------------------------
    const openCursor = b.session.logs.mark();
    const label = uiLabel(app!.manifest);
    let scope: Awaited<ReturnType<typeof openApp>>;
    try {
      scope = await openApp(
        b.session.inspector,
        appName,
        label,
        openOptionsFor(b.app, b.userDir?.root, appName, opts.timeoutMs),
      );
    } catch (err) {
      console.log(`  ${RED}FAIL${RST}  open ${appName}`);
      const e = err as OpenError;
      console.log(`        ${DIM}${e.message}${RST}`);
      // The log usually already knows WHY. Leading with a timeout hint while
      // the compiler's file:line sat unread in the buffer sent people to debug
      // the wrong thing.
      const why = explainOpenFailure(b.session.logs.slice(openCursor).map(parseLine), appName);
      if (why) for (const l of why.split("\n")) console.log(`        ${RED}${l}${RST}`);
      else if (e.hint) console.log(`        ${DIM}${e.hint}${RST}`);
      dumpTail(b.session.logs.slice(openCursor).map((l) => l.text));
      emitArtifacts(
        opts,
        stillbornReport(appName, b.basecamp?.path ?? "(attached)", b.fidelity, Date.now() - t0,
          `open ${appName}`, "fail", why ?? e.hint ?? e.message),
      );
      return 1;
    }

    // --- unlock, if a password was given ----------------------------------
    // Needs the app's QML root, which only exists now, so boot could not do it.
    if (b.walletUnlock && scope.qmlRootId) {
      const why = await unlockWallet(
        b.session.inspector,
        scope.qmlRootId,
        b.walletUnlock.provider,
        b.walletUnlock.password,
      );
      if (why) console.log(`  ${DIM}wallet${RST} ${RED}could not unlock: ${why}${RST}`);
      else console.log(`  ${DIM}wallet${RST} ${DIM}unlocked${RST}`);
    }

    // Evidence for "open" is taken now, before setup runs: a wallet being
    // created is not something the open step did, and attributing it there
    // turned a clean launch into a FAIL.
    const openEvidence = summarise(b, openCursor, appName, ignoreCalls);

    // --- setup ---------------------------------------------------------
    const setupOutcome = await runSetupProfile(b, resolvedSetup, appName, "crawl");
    const setupSteps = setupOutcome.steps;
    const setupFailed = setupOutcome.failed;
    if (setupFailed) problems++;

    let snap = await UiSnapshot.capture(b.session.inspector, scope.scopeId);
    // A QML error during load is a failure, not a footnote. Reporting PASS and
    // then printing the error underneath it was simply lying.
    const openBad = openEvidence.errors.length > 0 || openEvidence.failedCalls.length > 0;
    if (openBad) problems++;
    console.log(
      `  ${openBad ? RED + "FAIL" + RST : GRN + "PASS" + RST}  open ${appName}` +
        `${" ".repeat(Math.max(1, 36 - appName.length))}` +
        `${DIM}${snap.nodes.length} nodes, ${openEvidence.calls.length} call(s)${RST}`,
    );
    for (const e of openEvidence.errors.slice(0, 3)) console.log(`        ${RED}${e}${RST}`);
    for (const f of openEvidence.failedCalls.slice(0, 3)) console.log(`        ${RED}${f} failed${RST}`);

    // --- crawl --------------------------------------------------------------
    //
    // A real crawl, not a single pass over the opening screen. Clicking
    // navigates, so the controls visible at the start stop existing and any
    // controls the navigation revealed would never be visited — on medusa_ui
    // that meant 3 controls found in a 6,800-line wallet. Instead we keep a
    // frontier, re-derive it after every click, and enqueue whatever is new.
    // alsoLabelled travels with the target: the safety guard reads every label
    // that resolves to a control, and it must still do so after the target has
    // been through collapseRows and the frontier queue.
    type Target = {
      id: string;
      label: string;
      type: string;
      alsoLabelled?: string[];
      revealedBy?: { label: string; type: string };
    };
    const initial = collapseRows(collectClickables(snap).filter((c) => !BACK.test(c.label)));
    const queue: Target[] = initial.kept;
    let collapsedRows = initial.collapsed;
    const visited = new Set<string>();
    const results: SmokeClick[] = [];
    let clicks = 0;
    // Controls that were reachable when we queued them but had gone by the time
    // we got there, because an earlier click navigated away. Counting them is
    // the honest way to report coverage: the crawl does not backtrack, so what
    // it did not reach it simply did not test.
    const unreachable: string[] = [];
    /** Each click's evidence window, for reconciling failures that arrive late. */
    const windows: Array<{ label: string; from: number; to: number }> = [];

    if (queue.length === 0) {
      console.log(`\n  ${YEL}!${RST} no clickable controls found in ${appName}. Try \`sitometres inspect --hidden\`.\n`);
      // Inconclusive, not pass: the crawl opened the app and then proved
      // nothing about it. --strict is what turns that into a failing build.
      // Built the same way as a completed crawl, so a failed setup or a bad
      // open still reaches the artifact. stillbornReport cannot express either,
      // which is how a run could exit 1 with failures="0".
      const machine = crawlToMachineReport({
        version: VERSION,
        app: appName,
        basecamp: b.basecamp?.path ?? "(attached)",
        sandboxHome: b.sandboxHome,
        fidelity: b.fidelity,
        durationMs: Date.now() - t0,
        open: { ok: !openBad, errors: openEvidence.errors },
        ...(setupFailed ? { setupFailed } : {}),
        ...(openEvidence.failedCalls.length
          ? { openProblems: openEvidence.failedCalls.map((f) => `${f} failed while opening`) }
          : {}),
        clicks: [],
      });
      machine.steps.push({
        index: machine.steps.length,
        name: `crawl ${appName}`,
        action: "crawl",
        verdict: "inconclusive",
        durationMs: 0,
        checks: [{
          kind: "state",
          description: "some control was exercised",
          verdict: "inconclusive",
          detail: "no clickable controls were found, so nothing about this app was tested",
        }],
        callsObserved: [],
      });
      if (machine.steps.some((x) => x.verdict === "fail")) machine.verdict = "fail";
      else machine.verdict = "inconclusive";
      emitArtifacts(opts, machine);
      return problems > 0 || opts.strict === true ? 1 : 0;
    }
    console.log(`\n  ${DIM}clicking up to ${limit} control(s)${RST}\n`);

    // The crawl loop is wrapped so that losing the app does not lose the run.
    // A click that kills Basecamp makes the NEXT iteration's UiSnapshot.capture
    // throw on a dead socket, and that throw used to escape past the report
    // entirely: no table, no --json, no --junit, nothing written. Everything
    // learned before the app died is still worth having, and CI needs to be
    // told which control killed it rather than "no test results".
    let crawlDied: string | null = null;
    /** Which control was being clicked when the app died. */
    let crawlKilledBy: string | null = null;
    /** The control currently being clicked, for attributing a crash. */
    let inFlight: string | null = null;
    /** Controls whose gesture threw, so the artifact can report them. */
    const unclickable: Array<{ label: string; why: string }> = [];
    /** Failures seen near a click whose attribution is a guess. */
    const ambiguousFailures: Array<{ near: string; name: string }> = [];
    /** Controls deliberately not clicked, so coverage can be reported honestly. */
    const skippedControls: Array<{ label: string; why: string }> = [];
    try {
    while (queue.length > 0 && clicks < limit) {
      const t = queue.shift()!;
      // Identity is label+type: object ids churn as views are rebuilt, so an id
      // would revisit the same button under a new id and loop forever.
      const key = `${t.type}\u0000${t.label}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const allLabels = [t.label, ...(t.alsoLabelled ?? [])];
      const destructive = allLabels.find((l) => DESTRUCTIVE.test(l));
      const skipped = (opts.skip ?? []).find((sk) => allLabels.some((l) => l.includes(sk)));
      if (destructive || skipped) {
        // Name the label that triggered it. The guard reads every label that
        // resolves to a control, so "looks destructive" about a control called
        // "Refresh" — because a paragraph beside it says "confirm" — is a
        // statement the reader cannot check.
        const why = skipped
          ? `matches --skip ${JSON.stringify(skipped)}`
          : destructive === t.label
            ? "looks destructive"
            : `looks destructive: ${JSON.stringify(short(destructive!))} resolves to this control`;
        console.log(`  ${DIM}skip${RST}  ${JSON.stringify(short(t.label))} ${DIM}(${why})${RST}`);
        // Recorded, so coverage is honest: a skip used to appear in no report,
        // no --json and no JUnit, while `unreachable` and folded rows both did.
        skippedControls.push({ label: t.label, why });
        continue;
      }

      snap = await UiSnapshot.capture(b.session.inspector, scope.scopeId);
      const before = new Set(snap.labels());
      let reachedBy = "directly";
      let live: { id: string; how?: string } | null =
        snap.nodes.find((n) => n.id === t.id && n.visible)
        ?? collectClickables(snap).find((c) => c.label === t.label && c.type === t.type)
        ?? null;
      if (!live) {
        status.set("Running", `${JSON.stringify(short(t.label))} is gone — going back to find it`);
        live = await backtrackTo(b.session.inspector, scope.scopeId, t, settleMs);
        if (live) {
          reachedBy = "after going back";
          console.log(`  ${DIM}back${RST}  returned to reach ${JSON.stringify(short(t.label))}`);
        }
      }
      if (!live && t.revealedBy) {
        // Backtracking only unwinds. This control was revealed by clicking
        // something specific, so replay that one step forward to reach it.
        status.set("Running", `re-opening ${JSON.stringify(short(t.revealedBy.label))} to reach ${JSON.stringify(short(t.label))}`);
        live = await replayVia(b.session.inspector, scope.scopeId, t.revealedBy, t, settleMs);
        if (live) {
          reachedBy = `via ${t.revealedBy.label}`;
          console.log(`  ${DIM}via${RST}   re-opened ${JSON.stringify(short(t.revealedBy.label))} to reach ${JSON.stringify(short(t.label))}`);
        }
      }
      if (!live) {
        unreachable.push(t.label);
        continue;
      }
      const targetId = live.id;
      if (live.how && live.how !== "exact") {
        // Say when a looser match was used — a relabelled control is still the
        // right control, but the reader should know we did not match it exactly.
        console.log(`        ${DIM}(matched by ${live.how}; its label had changed)${RST}`);
      }

      const cursor = b.session.logs.mark();
      // Recorded BEFORE the gesture: if the app dies during the click or the
      // settle, this is the only record of which control was responsible.
      inFlight = t.label;
      clicks++;
      status.set("Running", `clicking ${JSON.stringify(short(t.label))} (${clicks}/${limit})`);
      try {
        await b.session.inspector.clickRef(targetId);
      } catch (err) {
        console.log(`  ${RED}FAIL${RST}  click ${JSON.stringify(short(t.label))} — ${(err as Error).message}`);
        problems++;
        // Recorded, not just counted: this used to bump `problems` — so the
        // process exited 1 — and then `continue` before results.push, leaving
        // the artifact reporting failures="0".
        unclickable.push({ label: t.label, why: (err as Error).message });
        inFlight = null;
        continue;
      }
      status.set("Running", `watching what ${JSON.stringify(short(t.label))} did (${settleMs}ms)`);
      await sleep(settleMs);

      const windowEnd = b.session.logs.mark();
      windows.push({ label: t.label, from: cursor, to: windowEnd });

      // Pair over everything since the app opened, not just this click's
      // window, and keep only the failures whose DISPATCH happened during this
      // click. Pairing the window alone made a click that dispatched something
      // healthy get blamed for an earlier click's timeout, by name and with
      // confident: true — reproduced before this change.
      const paired = [...pairFailures(b.session.logs.slice(openCursor).map(parseLine))];
      const mine = paired
        .filter(([, f]) => f.anchorSeq !== undefined && f.anchorSeq >= cursor && f.anchorSeq < windowEnd)
        .map(([, f]) => f);

      const after = await UiSnapshot.capture(b.session.inspector, scope.scopeId);
      const afterRoles = after.labelsWithRole();
      const newLabels = afterRoles.map((r) => r.text).filter((l) => !before.has(l));
      // Only prose may say the app succeeded or failed. A control's own name
      // says nothing, and text in a hand-rolled card could be either — see
      // UiSnapshot.labelsWithRole.
      const newMessageLabels = afterRoles
        .filter((r) => r.role === "message" && !before.has(r.text))
        .map((r) => r.text);
      const report = classifyOutcome({
        window: b.session.logs.slice(cursor).map(parseLine),
        newLabels,
        newMessageLabels,
        appName,
        ignoreCalls,
        logsUsable: b.fidelity.fidelity === "verbose",
        failures: mine,
      });

      const shown = (x: string) => stable(x, b.sandboxHome, b.userDir?.root ?? null);
      results.push({
        label: shown(t.label),
        type: t.type,
        outcome: report.outcome,
        evidence: report.evidence.map(shown),
        calls: report.calls,
        failedCalls: report.failedCalls,
        errors: report.errors.map(shown),
        newLabels: newLabels.map(shown),
        reachedBy,
      });

      const mark =
        report.outcome === "failed" ? `${RED}FAIL${RST}`
        : report.outcome === "worked" ? `${GRN}OK  ${RST}`
        : report.outcome === "ran" ? `${GRN}RAN ${RST}`
        : report.outcome === "nothing" ? `${YEL}NONE${RST}`
        : `${YEL}????${RST}`;
      if (report.outcome === "failed") problems++;
      // A hedged failure does not accuse this control — the outcome stays
      // `unclear` — but a call DID fail, and counting it nowhere is how the
      // crawl came to exit 0 on an app whose backend call failed.
      for (const h of report.hedgedFailures) {
        problems++;
        ambiguousFailures.push({ near: t.label, name: h });
      }

      console.log(`  ${mark}  click ${JSON.stringify(short(shown(t.label)))} ${DIM}${describeOutcome(report.outcome)}${RST}`);
      for (const e of report.evidence.slice(0, 4).map(shown)) {
        const bad = /failed|error|reported:/.test(e);
        console.log(`        ${bad ? RED : DIM}${short2(e)}${RST}`);
      }
      if (report.outcome === "ran") {
        console.log(`        ${DIM}the call was made; whether it succeeded is not visible from the log${RST}`);
      }
      if (report.outcome === "nothing") {
        // State the observation and its known blind spots, and stop asserting a cause.
        //
        // "nothing on screen changed — is the handler wired up?" sent readers debugging
        // working controls. Every one of these produces an identical trace:
        //   · a popup/menu, which renders into an overlay this view does not read
        //   · an update that changed VALUES under labels that already existed
        //   · navigation to a screen that reuses the same labels (tx detail -> tx detail)
        //   · a filter that reordered or shortened a list of same-shaped rows
        // Only the first line below is evidence; the rest is what it cannot distinguish.
        const looksLikeButton = /Button|Delegate|TabButton|MenuItem/.test(t.type);
        console.log(`        ${DIM}no backend call logged, and no new text appeared${RST}`);
        // eslint-disable-next-line max-len -- kept on one line so the docs test can match it verbatim
        console.log(`        ${DIM}that also looks like this for a popup, a value-only update, or a screen that reuses the same labels${RST}`);
        if (looksLikeButton) {
          console.log(`        ${DIM}it IS a control, so if none of those apply, check the handler${RST}`);
        }
      }

      // Anything the click revealed becomes new frontier.
      let discovered = 0;
      // Text the click just surfaced as a confirmation is a toast, not a
      // control: "Wallet CLI path copied" vanishes on its own, and queueing it
      // produces a click on nothing and a bogus "is the handler wired up?".
      const transient = new Set([...report.reportedSuccess, ...report.reportedErrors]);
      // Suppressed by IDENTITY, not by text. Dropping every fresh control whose
      // chosen label matched a confirmation dropped genuine controls too: a hit
      // area whose own label happens to read as one is still a control, and
      // because `untested` is built only from targets that were queued, such a
      // control vanished from the report altogether — the crawl then read as a
      // complete sweep when it was not. Only a label that does not NAME its
      // target — one that won on shared-container proximity alone — is a toast.
      const isToast = (c: { label: string; namedBy: NamedBy }) =>
        transient.has(c.label) && c.namedBy === "container";
      const afterClickables = collectClickables(after);
      for (const c of afterClickables) {
        if (!isToast(c) || skippedControls.some((s) => s.label === c.label)) continue;
        // Recorded, so coverage stays honest about what the crawl set aside.
        skippedControls.push({
          label: c.label,
          why: "the click surfaced this text as a confirmation, so it was read as a toast, not a control",
        });
      }
      const fresh = collapseRows(
        afterClickables.filter((c) => !BACK.test(c.label) && !isToast(c)),
      );
      collapsedRows += fresh.collapsed;
      for (const c of fresh.kept) {
        if (visited.has(`${c.type}\u0000${c.label}`)) continue;
        if (queue.some((q) => q.label === c.label && q.type === c.type)) continue;
        // One representative per row shape is enough; the rest are the same
        // control with different data.
        if (labelShape(c.label).includes("#")) {
          const already = [...visited].filter((v) => v.endsWith(labelShape(c.label))).length
            + queue.filter((q) => labelShape(q.label) === labelShape(c.label)).length;
          if (already >= ROWS_PER_SHAPE) {
            collapsedRows++;
            continue;
          }
        }
        // Remember what revealed it, so we can get back here later.
        queue.push({ ...c, revealedBy: { label: t.label, type: t.type } });
        discovered++;
      }
      if (discovered > 0) console.log(`        ${DIM}+${discovered} new control(s) reachable from here${RST}`);
      inFlight = null;
    }
    } catch (err) {
      crawlDied = (err as Error).message;
      problems++;
      // The control that KILLED the app is the one whose window was open, not
      // the last one that finished — a crashing click never reaches
      // results.push, so reading `results` named its predecessor and let the
      // real culprit disappear from every output. `windows` is appended before
      // grading, so its tail is the click that was in progress.
      crawlKilledBy = inFlight;
      console.log(
        `\n  ${RED}x${RST}  the app stopped responding${inFlight ? ` while clicking ${JSON.stringify(short(inFlight))}` : ""} — ` +
          `${crawlDied}`,
      );
      console.log(`  ${DIM}reporting what the crawl learned before that${RST}`);
    }

    // --- failures that arrived after their click's window closed -------------
    //
    // The transport gives up on a reply after 20 s; a crawl observes each click
    // for 2.5 s. So a timeout can NEVER land in the window of the click that
    // caused it. Until now it either fell in an innocent later click's window —
    // where pairFailures would pop THAT click's healthy dispatch and report it
    // as confidently failed — or landed in a gap and was dropped entirely, and
    // the run exited 0 having silently discarded a real failure.
    //
    // Pairing over the whole crawl instead, and charging each failure to the
    // click whose DISPATCH it was matched to, puts it where it belongs.
    const orphanFailures: string[] =
      b.fidelity.fidelity === "verbose"
        ? reconcileLateFailures(
            pairFailures(b.session.logs.slice(openCursor).map(parseLine)),
            windows,
            ignoreCalls,
          )
        : [];
    if (orphanFailures.length > 0) {
      problems += orphanFailures.length;
      console.log(
        `\n  ${RED}${orphanFailures.length} call(s) failed after their click's window${RST} ` +
          `${DIM}(a reply times out at 20s; a click is watched for ${settleMs}ms)${RST}`,
      );
      for (const name of orphanFailures.slice(0, 6)) console.log(`        ${RED}${name} failed${RST}`);
      if (orphanFailures.length > 6) console.log(`        ${DIM}…and ${orphanFailures.length - 6} more${RST}`);
    }

    // Four ways to reach the end having clicked nothing: every label looked
    // destructive, --skip covered them, --limit 0, or every control became
    // unreachable. All of them used to produce a passing report with one
    // passing testcase — a green CI job that tested nothing.
    if (results.length === 0 && unclickable.length === 0) {
      console.log(`\n  ${YEL}!${RST} no control was clicked, so this crawl proved nothing about ${appName}\n`);
    }

    const untested = [...new Set(unreachable)].map((u) => stable(u, b.sandboxHome, b.userDir?.root ?? null));
    const report: RunReport = {
      tool: "sitometres",
      version: VERSION,
      startedAt,
      durationMs: Date.now() - t0,
      app: app
        ? {
            name: app.manifest.name,
            type: app.manifest.type,
            ...(app.manifest.version ? { version: app.manifest.version } : {}),
            dependencies: app.manifest.dependencies,
            builtFrom: app.origin,
          }
        : null,
      basecamp: b.basecamp?.path ?? "(attached)",
      userDir: b.userDir?.root ?? null,
      sandboxHome: b.sandboxHome,
      wallet: b.walletSummary,
      fidelity: b.fidelity,
      open: {
        ok: !openBad,
        nodes: snap.nodes.length,
        calls: openEvidence.calls,
        errors: openEvidence.errors,
      },
      clicks: results.map((r) => ({
        label: r.label,
        type: r.type,
        outcome: r.outcome,
        evidence: r.evidence,
        calls: r.calls,
        reachedBy: r.reachedBy,
        ...(r.newLabels.length ? { newLabels: r.newLabels } : {}),
      })),
      setup: setupFile ? { file: setupFile, steps: setupSteps } : null,
      untested,
      ...(skippedControls.length ? { skipped: skippedControls } : {}),
      collapsedRows,
      problems,
      ...(crawlDied ? { endedEarly: crawlDied } : {}),
    };
    printReport(report);
    if (!opts.noReport) {
      const where = writeReport(report, opts.report ?? defaultReportPath(appName));
      console.log(`\n  ${DIM}report written to ${where}${RST}`);
    }

    // Computed here rather than after the artifact, because the artifact needs
    // them. `--strict` is about the RUN proving nothing, not about individual
    // controls being unclear: `unclear` is the normal outcome for most controls
    // in a real app — zonescan_lite produces one on its first screen — so
    // failing on it made --strict fail every healthy crawl and left no usable
    // CI gate at all.
    const provedNothing = crawlProvedNothing(results);
    const evidenceUnreadable = b.fidelity.fidelity !== "verbose";

    let inconclusive = 0;
    if (opts.junit || opts.json || opts.strict) {
      const machine = crawlToMachineReport({
        version: VERSION,
        app: appName,
        basecamp: b.basecamp?.path ?? "(attached)",
        fidelity: b.fidelity,
        durationMs: Date.now() - t0,
        open: { ok: !openBad, errors: openEvidence.errors },
        ...(crawlDied
          ? { endedEarly: crawlKilledBy ? `${crawlDied} (while clicking ${crawlKilledBy})` : crawlDied }
          : {}),
        ...(setupFailed ? { setupFailed } : {}),
        ...(orphanFailures.length || ambiguousFailures.length
          ? {
              orphanFailures: [
                ...orphanFailures,
                ...ambiguousFailures.map(
                  (a) => `${a.name} failed near ${JSON.stringify(short(a.near))} — attribution is a guess`,
                ),
              ],
            }
          : {}),
        ...(unclickable.length ? { unclickable } : {}),
        // NOT openEvidence.failedCalls: those dispatch before any click window,
        // so the end-of-crawl sweep already reports them. Passing both counted
        // one failure twice and took the artifact from failures="1" to "2" for
        // the same run.

        clicks: results.map((r) => ({
          label: r.label,
          outcome: r.outcome,
          evidence: r.evidence,
          calls: r.calls,
          newLabels: r.newLabels,
        })),
        // The two conditions that make --strict exit 1 used to be computed here
        // and passed nowhere, so a completed crawl could exit 1 while its own
        // JUnit said failures="0" and its verdict said "pass" — every clicked
        // control `nothing` under verbose fidelity does exactly that. The exit
        // code and the artifact must never disagree; a CI reader only ever sees
        // the artifact. Passed only under --strict, because only then do these
        // conditions affect the exit code at all.
        ...(opts.strict ? { strictGate: { provedNothing, evidenceUnreadable } } : {}),
      });
      inconclusive = machine.steps.filter((x) => x.verdict === "inconclusive").length;
      if (opts.json) writeOut(opts.json, toJson(machine));
      if (opts.junit) writeOut(opts.junit, toJUnit(machine));
    }

    if (queue.length > 0) {
      console.log(`\n  ${DIM}${queue.length} control(s) left unclicked — raise --limit (currently ${limit})${RST}`);
    }
    console.log("");

    if (opts.strict && (provedNothing || evidenceUnreadable)) {
      console.log(
        `  ${DIM}--strict: ${
          evidenceUnreadable
            ? "this session could not read log evidence, so nothing was verified"
            : "no control did anything observable, so this crawl proved nothing"
        }${RST}`,
      );
    }
    void inconclusive;
    return crawlExitCode({ problems, strict: opts.strict, provedNothing, evidenceUnreadable });
  } catch (err) {
    // Anything escaping the body — a throw before the crawl loop's own guard,
    // an inspector that died while the header was being built — must still
    // leave the evidence the caller asked for.
    emitArtifacts(
      opts,
      stillbornReport(b.app?.manifest.name ?? null, b.basecamp?.path ?? "(attached)", b.fidelity,
        Date.now() - t0, "complete the crawl", "fail", (err as Error).message),
    );
    throw err;
  } finally {
    await b.dispose();
  }
}

/**
 * Write the machine-readable artifacts, whatever happened.
 *
 * The crawl had three returns before any artifact was written — attach with no
 * app, a failed open, and "no clickable controls" — and the last of those
 * returns 0. So `sitometres <app> --junit results.xml` could exit green having
 * written no file at all, which every CI publisher reports as "no test
 * results": indistinguishable from a passing run that produced nothing, and
 * exactly what the JUnit output exists to prevent.
 */
function emitArtifacts(
  opts: SmokeOptions,
  machine: MachineReport,
): { inconclusive: number } {
  if (opts.json) writeOut(opts.json, toJson(machine));
  if (opts.junit) writeOut(opts.junit, toJUnit(machine));
  return { inconclusive: machine.steps.filter((x) => x.verdict === "inconclusive").length };
}

/** A one-step report for a crawl that ended before it could click anything. */
/** Fidelity placeholder for a run that never got far enough to assess one. */
const QUIET_FIDELITY: FidelityReport = {
  fidelity: "quiet",
  qtLogLines: 0,
  moduleLogLines: 0,
  summary: "the run did not start",
  remedy: "",
};

function stillbornReport(
  appName: string | null,
  basecamp: string,
  fidelity: FidelityReport,
  durationMs: number,
  what: string,
  verdict: "fail" | "inconclusive",
  detail: string,
): MachineReport {
  return {
    tool: "sitometres",
    version: VERSION,
    app: appName,
    basecamp,
    fidelity,
    verdict,
    durationMs,
    steps: [
      {
        index: 0,
        name: what,
        action: what,
        verdict,
        durationMs,
        checks: [{ kind: "state", description: what, verdict, detail }],
        callsObserved: [],
      },
    ],
  };
}

function writeOut(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Depth of the deepest ancestor shared by a label and the control it resolves to. */
function sharedDepth(snap: UiSnapshot, node: { index: number }, target: { id: string }): number {
  const t = snap.nodes.find((n) => n.id === target.id);
  const n = snap.nodes[node.index];
  if (!t || !n) return 0;
  const chain = new Set(snap.ancestors(t).map((a) => a.index));
  for (const a of snap.ancestors(n)) if (chain.has(a.index)) return a.depth;
  return 0;
}

/**
 * How the chosen label relates to the control it was chosen for.
 *
 * `self`/`ancestor` mean the label NAMES the control. `container` means it only
 * shares an enclosing container with a mouse handler — the hand-rolled card
 * idiom — so it may be the control's caption or may be prose that happens to
 * sit nearby. The crawl needs the distinction to tell a toast from a control.
 */
export type NamedBy = "self" | "ancestor" | "container";

export function collectClickables(
  snap: UiSnapshot,
): Array<{ id: string; label: string; type: string; alsoLabelled: string[]; namedBy: NamedBy }> {
  // Several text nodes can resolve to ONE control: a hand-rolled card is a
  // container with a MouseArea, and every label inside it — the button's own
  // text, and any caption that happens to share an ancestor — resolves to that
  // same handler. Taking the first in document order gave the control whichever
  // label came first on screen.
  //
  // That was not cosmetic. The destructive-label guard tests the label, so a
  // caption above a Send card meant DESTRUCTIVE.test("Review the details
  // below.") — false — and the crawl pressed Send and reported the caption.
  // Reproduced. On a wallet app that moves real value.
  //
  // So: group by target, pick the label most likely to BE the control's name,
  // and keep the rest so the safety check can consider all of them.
  const byTarget = new Map<
    string,
    { target: { id: string; type: string }; cands: Array<{ text: string; score: number; namedBy: NamedBy }> }
  >();
  for (const node of snap.nodes) {
    if (!node.text || !node.visible) continue;
    const { target, via } = snap.clickTargetFor(node);
    if ((via !== "hitArea" && !isClickableType(target.type)) || !target.enabled) continue;
    // A label that IS the control, or sits inside it, names it. A label that
    // merely shares an enclosing container does not — and the deeper the
    // container they share, the likelier it is really this control's caption.
    const score = via === "self" ? 1000 : via === "ancestor" ? 900 : sharedDepth(snap, node, target);
    const namedBy: NamedBy = via === "self" ? "self" : via === "ancestor" ? "ancestor" : "container";
    const entry = byTarget.get(target.id) ?? { target, cands: [] };
    entry.cands.push({ text: node.text, score, namedBy });
    byTarget.set(target.id, entry);
  }

  const out: Array<{ id: string; label: string; type: string; alsoLabelled: string[]; namedBy: NamedBy }> = [];
  for (const { target, cands } of byTarget.values()) {
    const ranked = [...cands].sort((a, b) => b.score - a.score);
    out.push({
      id: target.id,
      label: ranked[0]!.text,
      type: target.type,
      alsoLabelled: ranked.slice(1).map((c) => c.text),
      namedBy: ranked[0]!.namedBy,
    });
  }
  // Named controls before data-shaped ones, and back buttons last: clicking a
  // back arrow early would throw away the screen we are still exploring.
  return out.sort(
    (a, b) =>
      Number(BACK.test(a.label)) - Number(BACK.test(b.label)) ||
      Number(looksLikeData(a.label)) - Number(looksLikeData(b.label)),
  );
}

/**
 * Re-open the control that first revealed `want`, then look again.
 *
 * One step of forward replay. Enough for the common shape — a panel opened
 * from a chip or a tab — without pretending to reconstruct arbitrary paths.
 */
async function replayVia(
  inspector: InspectorClient,
  scopeId: string,
  via: Wanted,
  want: Wanted,
  settleMs: number,
): Promise<{ id: string; how: string } | null> {
  let snap = await UiSnapshot.capture(inspector, scopeId);
  let opener = findTarget(snap, via);
  if (!opener) {
    // The opener may itself be a screen away; unwind first.
    const back = await backtrackTo(inspector, scopeId, via, settleMs);
    if (!back) return null;
    opener = { id: back.id, how: "exact" as const };
  }
  try {
    await inspector.clickRef(opener.id);
  } catch {
    return null;
  }
  await sleep(settleMs);
  snap = await UiSnapshot.capture(inspector, scopeId);
  return findTarget(snap, want);
}

interface Wanted {
  label: string;
  type: string;
  /** Position among same-type clickables when it was queued. */
  ordinal?: number;
}

/**
 * Find a control again after the UI has moved on.
 *
 * Exact label matching is not enough, because labels are not stable: medusa's
 * zone row is "Paradox Computer" until it is probed and "Paradox Computer ·
 * clearnet" afterwards, and the chip that opens the zone panel is labelled with
 * whichever zone is active, so selecting a different one renames the door. Both
 * were being reported as unreachable when they were on screen the whole time.
 *
 * Three attempts, widening, and the caller is told which one hit so a loosened
 * match never passes silently as an exact one.
 */
export function findTarget(snap: UiSnapshot, want: Wanted): { id: string; how: "exact" | "prefix" | "position" } | null {
  const cands = collectClickables(snap);

  const exact = cands.find((c) => c.type === want.type && c.label === want.label);
  if (exact) return { id: exact.id, how: "exact" };

  // A label that grew, lost, or CHANGED a suffix is the same control. The zone
  // row reads "Paradox Computer" before it is probed, "Paradox Computer ·
  // clearnet" on one network and "Paradox Computer · Tor" on another — neither
  // of which is a prefix of the other, so a shared stem is what identifies it.
  const norm = normaliseText(want.label).toLowerCase();
  if (norm.length >= 4) {
    const scored = cands
      .filter((c) => c.type === want.type)
      .map((c) => ({ c, shared: sharedPrefix(norm, normaliseText(c.label).toLowerCase()) }))
      .filter((x) => x.shared >= Math.max(6, Math.min(norm.length, 12)));
    if (scored.length === 1) return { id: scored[0]!.c.id, how: "prefix" };
    if (scored.length > 1) {
      // Ambiguous on stem alone: take the longest shared stem, but only if it
      // is a clear winner. Two zones sharing a prefix must not be confused.
      scored.sort((a, z) => z.shared - a.shared);
      if (scored[0]!.shared > scored[1]!.shared) return { id: scored[0]!.c.id, how: "prefix" };
    }
  }

  // Last resort: same slot among controls of the same type. Only for named QML
  // types — an ordinal among bare QQuickMouseAreas identifies nothing.
  if (want.ordinal !== undefined && !/^QQuick(MouseArea|Item)$/.test(want.type)) {
    const sameType = cands.filter((c) => c.type === want.type);
    const at = sameType[want.ordinal];
    if (at) return { id: at.id, how: "position" };
  }
  return null;
}

/**
 * The "shape" of a label, with the data taken out.
 *
 * Rows in a table are one control repeated: zonescan lists zone ids as
 * "01010101…0101", "77777777…7777", "82010101…0101". Clicking seven of them
 * exercises exactly what clicking one does, and then reporting five as
 * "not reached" reads like a failure when it is just noise. Two labels with the
 * same shape and the same type are the same control with different data.
 */
export function labelShape(label: string): string {
  return normaliseText(label)
    .replace(/[0-9a-fA-F]{4,}/g, "#")
    .replace(/\d+/g, "#")
    .replace(/[…·]/g, "…")
    .toLowerCase();
}

/** How many rows of one shape are worth clicking. */
const ROWS_PER_SHAPE = 2;

/**
 * Collapse repeated list rows to a couple of representatives.
 * Returns the survivors plus a count of what was folded away, so the report can
 * say "sampled 2 of 7" instead of pretending the rest were unreachable.
 */
export function collapseRows<T extends { label: string; type: string }>(
  items: T[],
): { kept: T[]; collapsed: number } {
  const seen = new Map<string, number>();
  const kept: T[] = [];
  let collapsed = 0;
  for (const it of items) {
    const key = `${it.type}\u0000${labelShape(it.label)}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    // Only collapse once a shape is clearly a list, and never collapse a shape
    // that carries no data placeholder — those are distinct named controls.
    if (n > ROWS_PER_SHAPE && labelShape(it.label).includes("#")) {
      collapsed++;
      continue;
    }
    kept.push(it);
  }
  return { kept, collapsed };
}

/** Length of the common leading run of two strings. */
function sharedPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * Try to get back to a screen where `want` exists.
 *
 * Clicks whatever back affordance is on screen, up to `depth` times, checking
 * after each. Returns the live control, or null if we could not get there.
 */
async function backtrackTo(
  inspector: InspectorClient,
  scopeId: string,
  want: Wanted,
  settleMs: number,
  depth = 3,
): Promise<{ id: string; how: string } | null> {
  for (let i = 0; i < depth; i++) {
    const snap = await UiSnapshot.capture(inspector, scopeId);
    const back = collectClickables(snap).find((c) => BACK.test(c.label));
    if (!back) return null;
    try {
      await inspector.clickRef(back.id);
    } catch {
      return null;
    }
    await sleep(settleMs);
    const after = await UiSnapshot.capture(inspector, scopeId);
    const hit = findTarget(after, want);
    if (hit) return hit;
  }
  return null;
}

function summarise(
  b: Awaited<ReturnType<typeof boot>>,
  cursor: number,
  appName: string | null,
  ignoreCalls: string[],
): { calls: string[]; failedCalls: string[]; errors: string[] } {
  // Delegates rather than re-implementing. This function used to be a third
  // copy of evidence extraction and the only one missing both guards: it did
  // not filter QML errors by whose app they came from, so any qrc:-owned error
  // Basecamp threw while building the dock was blamed on the module under test
  // and failed the run; and it matched the ignore list by exact string, so the
  // bare-method and "module.*" forms every other path accepts did not work.
  const report = classifyOutcome({
    window: b.session.logs.slice(cursor).map(parseLine),
    // The open step is not a click, so nothing "became newly visible" in the
    // sense classifyOutcome means; only the call/error evidence is wanted here.
    newLabels: [],
    appName,
    ignoreCalls,
    logsUsable: b.fidelity.fidelity === "verbose",
  });
  return { calls: report.calls, failedCalls: report.failedCalls, errors: report.errors };
}

function dumpTail(lines: string[]): void {
  for (const l of lines.slice(-12)) console.log(`        ${DIM}| ${l}${RST}`);
}
