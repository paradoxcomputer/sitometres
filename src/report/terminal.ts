// ---------------------------------------------------------------------------
// Terminal output.
//
// The report has to answer three questions at a glance: did it pass, what did
// the app actually do, and — when something is unproven — why. The last one is
// why INCONCLUSIVE gets its own symbol and its own remedy line instead of
// being folded into pass or fail.
// ---------------------------------------------------------------------------

import type { FidelityReport } from "../runner/fidelity.js";
import type { Check, Verdict } from "../runner/assert.js";
import type { RunResult, StepResult } from "../runner/runner.js";

const useColour = process.stdout.isTTY && process.env.NO_COLOR === undefined;

const c = {
  reset: useColour ? "\x1b[0m" : "",
  dim: useColour ? "\x1b[2m" : "",
  bold: useColour ? "\x1b[1m" : "",
  red: useColour ? "\x1b[31m" : "",
  green: useColour ? "\x1b[32m" : "",
  yellow: useColour ? "\x1b[33m" : "",
  blue: useColour ? "\x1b[34m" : "",
  cyan: useColour ? "\x1b[36m" : "",
};

const DIMWARN = useColour ? "\x1b[33m" : "";
const RSTWARN = useColour ? "\x1b[0m" : "";

const MARK: Record<Verdict, string> = {
  pass: `${c.green}PASS${c.reset}`,
  fail: `${c.red}FAIL${c.reset}`,
  inconclusive: `${c.yellow}????${c.reset}`,
};

export interface HeaderInfo {
  app: string;
  appType: string;
  dependencies: string[];
  basecamp: string;
  userDir: string;
  /** Apps already in a caller-supplied user-dir that this run did not stage. */
  foreignApps?: string[];
  /** Apps whose installed directory this run deleted and rewrote. */
  replacedApps?: string[];
  /** True when the run will put the user-dir back the way it found it. */
  restoresUserDir?: boolean;
  /** Apps already staged at their destination, so nothing was copied. */
  inPlaceApps?: string[];
  /** True when the run holds an unlocked wallet, for the inspector advisory. */
  walletUnlocked?: boolean;
  /**
   * The throwaway $HOME the app was given, or null when it saw the real one.
   *
   * Nothing stated this. Worse than silence: a --real-home run still printed
   * `user-dir /tmp/sitometres-…`, so the one line that looks like it is about
   * isolation read MORE isolated than the run actually was.
   */
  sandboxHome?: string | null;
  /** True when driving a Basecamp we did not start, so we chose nothing. */
  attached?: boolean;
  logSource: string;
  fidelity: FidelityReport;
  headless: boolean;
  /** Where the tested build came from, and how old it is. */
  source?: { origin: string; form: string; builtAt: number; version?: string };
  /**
   * The inspector port. Shown in BOTH modes, and worded differently in each.
   *
   * It used to be omitted when attached, on the grounds that the run did not choose it — but
   * that is exactly when the reader most needs it. `--attach` defaults to 3768, so it silently
   * drives whatever Basecamp happens to be listening there, which may be an instance the
   * developer started by hand hours earlier and forgot. A run that reports its findings
   * against the wrong process, and never says which process, is very hard to unpick.
   */
  inspectorPort?: number;
  /** Which wallet identity the app is running against. */
  wallet?: string;
}

/** Box-drawing wordmark. Generated so the columns line up; do not hand-edit. */
const BANNER = [
  "┌─┐┬┌┬┐┌─┐┌┬┐┌─┐┌┬┐┬─┐┌─┐┌─┐",
  "└─┐│ │ │ ││││├┤  │ ├┬┘├┤ └─┐",
  "└─┘┴ ┴ └─┘┴ ┴└─┘ ┴ ┴└─└─┘└─┘",
];

export function printBanner(version: string): void {
  const tint = useColour ? "\x1b[36m" : "";
  console.log("");
  for (const row of BANNER) console.log(`  ${tint}${row}${c.reset}`);
  console.log(
    `  ${c.dim}UI tests for Logos Basecamp apps${c.reset}  ${c.dim}v${version}${c.reset}`,
  );
  console.log(
    `  ${c.dim}by Paradox Computer${c.reset}  ${c.dim}·${c.reset}  ${c.dim}MIT OR Apache-2.0${c.reset}`,
  );
  console.log("");
}

export function printHeader(h: HeaderInfo): void {
  const line = (k: string, v: string) => console.log(`  ${c.dim}${k.padEnd(9)}${c.reset} ${v}`);
  line("app", `${c.cyan}${h.app}${c.reset} (${h.appType})${h.dependencies.length ? ` -> ${h.dependencies.join(", ")}` : ""}`);
  if (h.source) {
    // "Is this my latest build?" should not require reasoning about which of
    // several copies of the app sitometres happened to pick.
    const v = h.source.version ? `v${h.source.version}, ` : "";
    line("built", `${h.source.origin} (${v}${h.source.form}, ${ago(h.source.builtAt)})`);
  }
  line("basecamp", h.basecamp);
  line("user-dir", h.userDir);
  // Only ever set for a caller-supplied --user-dir. Basecamp loads these too,
  // so the run is not the isolated thing the word "user-dir" implies, and
  // nothing here was deleted to make room for the app under test.
  if (h.foreignApps && h.foreignApps.length > 0) {
    line("also here", `${c.dim}${h.foreignApps.join(", ")} (already installed, left alone)${c.reset}`);
  }
  // The other half of that sentence, which used to be missing entirely. Staging
  // deletes and rewrites the destination of the app under test and of every
  // dependency, so a header that named only what survived — under docs that
  // said "nothing already in it is deleted" — described a guarantee the run
  // did not give.
  if (h.replacedApps && h.replacedApps.length > 0) {
    line(
      "replaced",
      h.restoresUserDir
        ? `${h.replacedApps.join(", ")} ${c.dim}(moved aside; put back when the run ends)${c.reset}`
        : `${c.yellow}${h.replacedApps.join(", ")}${c.reset} ${c.dim}(staged over, and left there — --keep-staged)${c.reset}`,
    );
  }
  if (h.inPlaceApps && h.inPlaceApps.length > 0) {
    line("in place", `${c.dim}${h.inPlaceApps.join(", ")} (already installed here; tested where it lies)${c.reset}`);
  }
  if (h.sandboxHome !== undefined) {
    // Three states, not two. Attach mode did not choose a HOME at all — it is
    // driving somebody else's process — and rendering its null as "your real
    // $HOME (--real-home)" asserted something the run never did, while
    // `basecamp` and `user-dir` on the same screen already say "(attached)".
    line(
      "home",
      h.attached
        ? "(attached)"
        : h.sandboxHome === null
          ? `${c.yellow}your real $HOME${c.reset} ${c.dim}(--real-home)${c.reset}`
          : `${h.sandboxHome} ${c.dim}(throwaway; tool dirs link through to the real ones)${c.reset}`,
    );
  }
  line("mode", `${h.headless ? "headless (offscreen)" : "windowed"}, logs from ${h.logSource}`);
  if (h.wallet) line("wallet", h.wallet);
  if (h.inspectorPort !== undefined) {
    // QTcpServer::listen(QHostAddress::Any) — verified as `LISTEN *:<port>`.
    // The inspector has no authentication and exposes `evaluate`, so while a
    // run is in progress anyone who can reach the port can execute code in the
    // app. Worth knowing on a shared or untrusted network.
    line(
      "inspector",
      h.attached
        ? `port ${h.inspectorPort} ${c.yellow}(attached — this run did not start it)${c.reset} ` +
          `${DIMWARN}whatever is listening there is what was tested${RSTWARN}`
        : `port ${h.inspectorPort} ${DIMWARN}(all interfaces, unauthenticated)${RSTWARN}`,
    );
  }

  // One fixed advisory said the same thing whether the app held a throwaway
  // sandbox or the developer's real $HOME and an unlocked real wallet — the
  // two cases where the exposure actually costs something, and the combination
  // the help text describes as the way to test against real data. Basecamp
  // binds the port itself, so this cannot be narrowed to loopback from here;
  // what CAN be done is stop understating it.
  const realDataExposed = h.inspectorPort !== undefined && !h.attached && (h.sandboxHome === null || h.walletUnlocked === true);
  if (realDataExposed) {
    const what = h.sandboxHome === null && h.walletUnlocked
      ? "your real $HOME and an unlocked wallet"
      : h.sandboxHome === null
        ? "your real $HOME, and therefore the wallet and settings Basecamp is configured with"
        : "an unlocked wallet";
    console.log(
      `\n  ${c.yellow}!${c.reset} this run exposes ${what} through an unauthenticated port on every interface.`,
    );
    for (const l of wrap(
      `Anyone who can reach port ${h.inspectorPort} can evaluate code inside the app for as long as the run lasts. ` +
        `Run it on a trusted network, or drop --real-home so the app sees a throwaway $HOME instead.`,
      74,
    )) {
      console.log(`    ${c.dim}${l}${c.reset}`);
    }
  }

  if (h.fidelity.fidelity === "quiet") {
    console.log(`\n  ${c.yellow}!${c.reset} ${h.fidelity.summary}`);
    if (h.fidelity.remedy) {
      for (const l of wrap(h.fidelity.remedy, 74)) console.log(`    ${c.dim}${l}${c.reset}`);
    }
  }
  console.log("");
}

export function printStep(s: StepResult): void {
  const dur = `${c.dim}${fmtMs(s.durationMs)}${c.reset}`;
  console.log(`  ${MARK[s.verdict]}  ${s.name}${" ".repeat(Math.max(1, 42 - visibleLen(s.name)))}${dur}`);

  if (s.action && s.action !== s.name) console.log(`        ${c.dim}${s.action}${c.reset}`);

  for (const chk of s.checks) printCheck(chk);

  if (s.callsObserved.length > 0 && !s.checks.some((k) => k.kind === "calls")) {
    console.log(`        ${c.dim}calls: ${s.callsObserved.join(", ")}${c.reset}`);
  }
  if (s.error) {
    for (const l of s.error.split("\n")) console.log(`        ${c.red}${l}${c.reset}`);
  }
}

function printCheck(chk: Check): void {
  if (chk.verdict === "pass") {
    console.log(`        ${c.green}+${c.reset} ${c.dim}${chk.description}${c.reset}`);
    return;
  }
  const colour = chk.verdict === "fail" ? c.red : c.yellow;
  const sym = chk.verdict === "fail" ? "x" : "?";
  console.log(`        ${colour}${sym}${c.reset} ${chk.description}`);
  if (chk.detail) {
    for (const l of chk.detail.split("\n")) console.log(`          ${c.dim}${l}${c.reset}`);
  }
}

export function printSummary(r: RunResult): void {
  const pass = r.steps.filter((s) => s.verdict === "pass").length;
  const fail = r.steps.filter((s) => s.verdict === "fail").length;
  const unknown = r.steps.filter((s) => s.verdict === "inconclusive").length;

  const bits = [`${c.green}${pass} passed${c.reset}`];
  if (fail) bits.push(`${c.red}${fail} failed${c.reset}`);
  if (unknown) bits.push(`${c.yellow}${unknown} inconclusive${c.reset}`);

  console.log(`\n  ${bits.join(", ")} ${c.dim}in ${fmtMs(r.durationMs)}${c.reset}\n`);
}

export function note(msg: string): void {
  console.log(`  ${c.blue}i${c.reset} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${c.yellow}!${c.reset} ${msg}`);
}

export function fail(msg: string): void {
  console.error(`  ${c.red}x${c.reset} ${msg}`);
}

/** Coarse relative time; precision beyond a minute is noise here. */
function ago(epochMs: number): string {
  if (!epochMs) return "unknown age";
  // Nix normalises store timestamps to the epoch, so "20674 days ago" is a
  // property of the store, not of the build. Say what is actually true.
  if (epochMs < 86_400_000) return "from the nix store";
  const s = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function wrap(s: string, width: number): string[] {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      out.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) out.push(line);
  return out;
}
