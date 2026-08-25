// ---------------------------------------------------------------------------
// `sitometres doctor` — can this machine run a UI test at all, and what will
// the results be worth?
//
// The second half matters as much as the first: a Release Basecamp will launch
// and drive perfectly well while being unable to report a single backend call,
// and a developer should learn that here rather than from a wall of
// INCONCLUSIVE later.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { discoverApps, hasInspector, isExecutableFile, locateBasecamp, staleRememberedBasecamp } from "../app/discover.js";
import { configPath, saveConfig } from "../config.js";
import { malformed, uiLabel } from "../app/manifest.js";
import { basecampUserDirs, boot, type CommandDeps, REAL_DEPS } from "../session.js";
import { status } from "../report/status.js";

export interface DoctorOptions {
  cwd?: string;
  app?: string;
  /** Remember this Basecamp path for future runs. */
  setBasecamp?: string;
  basecamp?: string;
  /** Actually launch Basecamp to measure log fidelity. */
  deep?: boolean;
}

// Same rule as every other reporter: honour a pipe and NO_COLOR. `doctor` is
// the command whose output people paste into an issue, so it is the last place
// escape codes should survive a redirect.
const colour = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: string, s: string) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s);
const OK = paint("32", "+");
const BAD = paint("31", "x");
const MEH = paint("33", "!");
const DIM = colour ? "\x1b[2m" : "";
const RST = colour ? "\x1b[0m" : "";

export async function doctor(opts: DoctorOptions = {}, deps: CommandDeps = REAL_DEPS): Promise<number> {
  // doctor is a report, not a long operation; a spinner over it just flickers.
  status.stop("Completed");
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  let problems = 0;

  console.log(`\n${paint("1", "sitometres doctor")}\n`);

  if (opts.setBasecamp) {
    const resolved = path.resolve(opts.setBasecamp);
    if (!fs.existsSync(resolved)) {
      console.log(`  ${BAD} ${resolved} does not exist\n`);
      return 1;
    }
    // Existence is not enough: a path without the execute bit is remembered,
    // then fails at spawn() on every later run.
    if (!isExecutableFile(resolved)) {
      console.log(`  ${BAD} ${resolved} is not executable, so sitometres could never launch it\n`);
      return 1;
    }
    if (!hasInspector(resolved)) {
      console.log(`  ${BAD} ${resolved} has no QML inspector compiled in — sitometres cannot drive it`);
      console.log(`    ${DIM}build one with: cd logos-basecamp && nix build .#default${RST}\n`);
      return 1;
    }
    const file = saveConfig({ basecamp: resolved });
    console.log(`  ${OK} remembered ${resolved}`);
    console.log(`    ${DIM}written to ${file}${RST}\n`);
    return 0;
  }

  // --- node ---------------------------------------------------------------
  const major = Number(process.versions.node.split(".")[0]);
  console.log(`  ${major >= 20 ? OK : BAD} node ${process.versions.node}${major >= 20 ? "" : "  (need >= 20)"}`);
  if (major < 20) problems++;

  // --- the app ------------------------------------------------------------
  const apps = discoverApps(cwd);
  if (apps.length === 0) {
    console.log(`  ${BAD} no Logos app found in ${cwd}`);
    console.log(`    ${DIM}looked for plugins/<name>/, modules/<name>/, ./metadata.json, *.lgx${RST}`);
    problems++;
  } else {
    console.log(`  ${OK} found ${apps.length} app(s) in ${cwd}`);
    for (const a of apps) {
      const deps = a.manifest.dependencies.length ? ` -> ${a.manifest.dependencies.join(", ")}` : "";
      const age = a.builtAt ? `, built ${Math.round((Date.now() - a.builtAt) / 60000)} min ago` : "";
      const stub = a.incomplete ? `  ${MEH} NOT BUILT` : "";
      console.log(`    ${DIM}${a.slot}/${a.manifest.name}  ${a.manifest.type}  "${uiLabel(a.manifest)}"${deps}  [${a.origin}${age}]${RST}${stub}`);
    }
  }

  if (malformed.length > 0) {
    console.log(`  ${MEH} ${malformed.length} manifest(s) could not be parsed and were skipped:`);
    for (const m of malformed.slice(0, 5)) console.log(`    ${DIM}${m.file} — ${m.reason}${RST}`);
  }

  // --- basecamp -----------------------------------------------------------
  const binaries = locateBasecamp(opts.basecamp);
  const usable = binaries.filter((b) => b.inspectorEnabled);
  if (binaries.length === 0) {
    console.log(`  ${BAD} no Basecamp binary found`);
    console.log(`    ${DIM}build one: cd logos-basecamp && nix build .#default${RST}`);
    console.log(`    ${DIM}then remember it: sitometres doctor --set-basecamp <path>${RST}`);
    problems++;
  } else if (usable.length === 0) {
    console.log(`  ${BAD} found Basecamp, but none with the QML inspector compiled in:`);
    for (const b of binaries) console.log(`    ${DIM}${b.path}  (${b.origin})${RST}`);
    console.log(`    ${DIM}the inspector is compile-time and OFF in release builds — build .#default or .#bin-bundle-dir-inspector${RST}`);
    console.log(`    ${DIM}already have one? remember it: sitometres doctor --set-basecamp <path>${RST}`);
    problems++;
  } else {
    console.log(`  ${OK} Basecamp with inspector: ${usable[0]!.path}`);
    if (staleRememberedBasecamp) {
      // Recovering silently would leave the bad entry in place to confuse the
      // next person; naming the file is the whole point.
      console.log(`  ${MEH} the remembered path ${staleRememberedBasecamp} is gone or not executable`);
      console.log(`    ${DIM}this one was found by searching instead. Fix it with:${RST}`);
      console.log(`    ${DIM}sitometres doctor --set-basecamp ${usable[0]!.path}${RST}`);
      console.log(`    ${DIM}or edit ${configPath()}${RST}`);
    }
    console.log(`    ${DIM}found via ${usable[0]!.origin}${RST}`);
    for (const b of binaries.filter((x) => !x.inspectorEnabled)) {
      console.log(`    ${DIM}(ignoring ${b.path} — no inspector)${RST}`);
    }
  }

  // --- dependencies resolvable -------------------------------------------
  if (apps.length > 0) {
    const names = new Set(apps.map((a) => a.manifest.name));
    // The same resolver discovery uses. This list used to be a third copy that
    // knew neither the macOS locations nor $LOGOS_USER_DIR, so doctor reported
    // a dependency missing that the crawl would have found.
    const installedDirs = basecampUserDirs().filter((d) => fs.existsSync(d));
    const installed = new Set(installedDirs.flatMap((d) => discoverApps(d).map((a) => a.manifest.name)));
    for (const a of apps) {
      for (const dep of a.manifest.dependencies) {
        if (names.has(dep) || installed.has(dep)) continue;
        console.log(`  ${MEH} ${a.manifest.name} depends on "${dep}", which is not here or installed`);
        console.log(`    ${DIM}build it and pass --with ${dep}, or install it into Basecamp first${RST}`);
      }
    }
  }

  // --- deep check ---------------------------------------------------------
  if (opts.deep && usable.length > 0 && apps.length > 0) {
    console.log(`\n  ${DIM}launching Basecamp to measure log fidelity...${RST}`);
    try {
      const bootOpts: Parameters<typeof boot>[0] = { cwd };
      if (opts.app) bootOpts.app = opts.app;
      if (opts.basecamp) bootOpts.basecamp = opts.basecamp;
      const b = await deps.boot(bootOpts);
      try {
        console.log(`  ${OK} launched and reached the shell in ${b.ready.uiProbeMs}ms`);
        console.log(`    ${DIM}modules loaded: ${b.ready.modulesLoaded.join(", ") || "(none)"}${RST}`);
        if (b.fidelity.fidelity === "verbose") {
          console.log(`  ${OK} ${b.fidelity.summary}`);
        } else {
          console.log(`  ${MEH} ${b.fidelity.summary}`);
          console.log(`    ${DIM}${b.fidelity.remedy}${RST}`);
        }
      } finally {
        await b.dispose();
      }
    } catch (err) {
      console.log(`  ${BAD} could not launch: ${(err as Error).message.split("\n")[0]}`);
      problems++;
    }
  } else if (!opts.deep) {
    console.log(`\n  ${DIM}run with --deep to launch Basecamp and check what the logs will show${RST}`);
  }

  console.log(problems === 0 ? `\n  ready to test\n` : `\n  ${problems} problem(s) to fix first\n`);
  return problems === 0 ? 0 : 1;
}
