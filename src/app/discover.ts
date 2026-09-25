// ---------------------------------------------------------------------------
// Finding the app under test, and the Basecamp that will host it.
//
// A developer runs `sitometres` from their module repo. What lives there varies:
//
//   <repo>/plugins/<name>/manifest.json    built UI plugin   (medusa, tip_jar…)
//   <repo>/modules/<name>/manifest.json    built core module
//   <repo>/metadata.json                   the source manifest at the root
//   <repo>/result/*.lgx                    a nix-bundled package
//
// All four are accepted so that `sitometres smoke` works with no arguments
// wherever the developer happens to be standing.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { loadConfig } from "../config.js";
import { type AppManifest, type LoadedManifest, normaliseManifest, readManifestDir, uiLabel } from "./manifest.js";

export interface DiscoveredApp {
  manifest: AppManifest;
  /**
   * Null when the artifact looks loadable, otherwise why it does not.
   *
   * A repo often carries a manifest-only stub of a module whose real library is
   * produced by the build — medusa's `modules/medusa_core/` declares
   * `main: medusa_core_plugin.so` and contains nothing but two JSON files.
   * Staging that silently yields a dependency that never loads and a UI plugin
   * that fails with no useful message, so we detect it at discovery time.
   */
  incomplete?: string;
  /** Directory to copy into the user-dir, or the .lgx to unpack. */
  artifact: string;
  /** "dir" = ready-to-copy plugin/module tree; "lgx" = packaged archive. */
  form: "dir" | "lgx";
  /**
   * True when this is something Basecamp can load, rather than the repo it is
   * built from.
   *
   * Basecamp loads `manifest.json` — the BUILT manifest the packager emits. A
   * source checkout carries only `metadata.json`, the one a developer edits, so
   * staging it produces a plugin Basecamp silently declines to list. Every
   * `.lgx` is built by definition.
   */
  built: boolean;
  /** Where it belongs under the user-dir. */
  slot: "plugins" | "modules";
  /** Human-readable provenance for the report header. */
  origin: string;
  label: string;
  /**
   * Newest mtime inside the artifact, in epoch ms.
   *
   * A repo commonly holds the same app twice — an unpacked `plugins/<name>/`
   * and a freshly built `result/*.lgx` — and testing yesterday's copy of code
   * you just rebuilt is a silent, expensive mistake. Whichever is newer wins,
   * and the header prints what was chosen and how old it is.
   *
   * Stays a number, because it is exported and already published as
   * `source.builtAt`. A nix store normalises every mtime to the epoch, so read
   * it through knownBuildTime(), which says "unknown" instead of "1970".
   */
  builtAt: number;
  /**
   * Whether this copy lives under a Basecamp user-dir ("installed") or was
   * found anywhere else ("local"). Decided from the path, once, at discovery.
   *
   * A local build beats an installed copy of the same version. Without this the
   * installed copy won whenever its mtime was newer, and a nix-built
   * `result/*.lgx` always reports the epoch, so a run tested the install
   * instead of the build that had just been made.
   */
  provenance: Provenance;
}

/** Where a copy of an app was found. See DiscoveredApp.provenance. */
export type Provenance = "local" | "installed";

/**
 * Why a copy lost to another copy of the same app, for the report.
 *
 *   incomplete     it is missing what its manifest promises
 *   source-only    it is a source tree (metadata.json), the other is built
 *   lower-version  the other copy declares a higher version
 *   installed      it is installed, the other is a local build of the same version
 *   older          both build times are known, and the other one is newer
 *   untimed-tie    everything tied and a build time is unknown, so the copy
 *                  found first was kept
 *   out-of-range   the app declares a version range for this dependency
 *                  (0.3.0's object form), and only the other copy is in it
 */
export type PassReason =
  | "incomplete" | "source-only" | "lower-version" | "installed" | "older" | "untimed-tie" | "out-of-range";

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "build", "dist", "target", ".direnv", "outputs", "testdata",
  // logos-basecamp/tests/sandbox/evil_app is a deliberate sandbox-escape
  // fixture that is perfectly loadable — exactly the thing not to auto-select.
  "tests", "test", "__tests__",
]);

/**
 * Types Basecamp can load from a user-dir.
 *
 * Anything else is a manifest for something that is not a plugin at all —
 * logos-basecamp/qt-ios declares type "app" with neither view nor library, so
 * it makes no promises, passes every completeness check by vacuity, and is
 * still unstageable.
 */
const LOADABLE_TYPES = new Set(["ui_qml", "core"]);

/**
 * Plugins that ship inside Basecamp itself.
 *
 * Running sitometres from a logos-basecamp checkout otherwise "discovers" six
 * apps from result/plugins/ — main_ui, package_manager_ui and friends. They are
 * genuinely complete built trees, so completeness cannot exclude them; they are
 * simply never the app under test.
 */
const BASECAMP_BUILTINS = new Set([
  "main_ui", "package_manager_ui", "package_manager", "package_downloader",
  "capability_module", "logos_ios_app",
  // 0.3.0 embeds a fourth core module.
  "modules_state",
]);

/**
 * Look for apps in and under `root`. Shallow by design — a couple of levels is
 * enough for every real layout, and deep walks over a Nix-heavy repo are slow.
 *
 * One copy per name: the best of every copy found, by compareCopies. Use
 * discoverCopies() for every copy, the ones that lost included.
 */
export function discoverApps(root: string): DiscoveredApp[] {
  const found = new Map<string, DiscoveredApp>();
  for (const copy of discoverCopies(root)) {
    if (better(copy, found.get(copy.manifest.name))) found.set(copy.manifest.name, copy);
  }
  // UI plugins first: those are the ones a UI test can actually drive.
  return [...found.values()].sort((a, b) => Number(b.slot === "plugins") - Number(a.slot === "plugins"));
}

/**
 * Every copy of every app in and under `root`, in the order they were found.
 *
 * The order is part of the answer: when two copies tie on everything
 * compareCopies can see, the one found first is kept, so staging stays stable
 * rather than flipping with the filesystem's listing order.
 */
export function discoverCopies(root: string): DiscoveredApp[] {
  const copies: DiscoveredApp[] = [];
  const installedRoots = realUserDirs();
  const add = (copy: Omit<DiscoveredApp, "provenance">): void => {
    if (BASECAMP_BUILTINS.has(copy.manifest.name)) return;
    copies.push({ ...copy, provenance: provenanceOf(copy.artifact, installedRoots) });
  };

  const addDir = (dir: string, slot: "plugins" | "modules", origin: string) => {
    const loaded = readManifestDir(dir);
    if (!loaded) return;
    add({
      manifest: loaded.manifest,
      artifact: dir,
      form: "dir",
      built: path.basename(loaded.source) === "manifest.json",
      slot: slot ?? slotFor(loaded.manifest),
      origin,
      label: uiLabel(loaded.manifest),
      ...withCompleteness(loaded.manifest, dir),
      builtAt: newestMtime(dir),
    });
  };

  // 1. Conventional built-output trees, including one level of nesting so a
  //    monorepo like medusa/ (apps live in medusa/module/plugins/) still works.
  for (const base of [root, ...childDirs(root)]) {
    for (const slot of ["plugins", "modules"] as const) {
      const slotDir = path.join(base, slot);
      if (!isDir(slotDir)) continue;
      for (const entry of childDirs(slotDir)) {
        addDir(entry, slot, path.relative(root, entry) || entry);
      }
    }
  }

  // 2. cwd is itself a plugins/ or modules/ dir (or any dir of app folders),
  //    which is where you land after `cd modules`.
  for (const entry of childDirs(root)) {
    const loaded = readManifestDir(entry);
    if (!loaded) continue;
    add({
      manifest: loaded.manifest,
      artifact: entry,
      form: "dir",
      built: path.basename(loaded.source) === "manifest.json",
      slot: slotFor(loaded.manifest),
      origin: path.relative(root, entry) || entry,
      label: uiLabel(loaded.manifest),
      ...withCompleteness(loaded.manifest, entry),
      builtAt: newestMtime(entry),
    });
  }

  // 3. A source manifest sitting at the repo root.
  const rootManifest = readManifestDir(root);
  if (rootManifest) {
    add({
      manifest: rootManifest.manifest,
      artifact: root,
      form: "dir",
      built: path.basename(rootManifest.source) === "manifest.json",
      slot: slotFor(rootManifest.manifest),
      origin: path.basename(rootManifest.source),
      label: uiLabel(rootManifest.manifest),
      ...withCompleteness(rootManifest.manifest, root),
      builtAt: newestMtime(root),
    });
  }

  // 4. Packaged .lgx bundles, typically behind the `result` symlink.
  // Nix produces one output directory per attribute, so a repo routinely has
  // result, result-phase2, result-picker … and package repos keep bundles in
  // lgx/. Scanning only ./result found none of them.
  const lgxDirs = [root, path.join(root, "dist"), path.join(root, "lgx")];
  for (const name of safeReaddir(root)) {
    if (/^result/.test(name)) lgxDirs.push(path.join(root, name));
  }
  for (const dir of lgxDirs) {
    if (!isDir(dir)) continue;
    for (const name of safeReaddir(dir)) {
      if (!name.endsWith(".lgx")) continue;
      const file = path.join(dir, name);
      const manifest = readLgxManifest(file);
      if (!manifest) continue;
      add({
        manifest,
        artifact: file,
        form: "lgx",
        built: true,
        ...lgxCompleteness(file, manifest),
        slot: slotFor(manifest),
        origin: path.relative(root, file) || file,
        label: uiLabel(manifest),
        builtAt: newestMtime(file),
      });
    }
  }

  // A nix out-link dates what it points at. Every file in the store reads the
  // epoch, so a fresh `nix build` and one from last year look the same from
  // inside. The `result` link itself is written when the build finishes, so
  // its own mtime is when those bytes were produced, and it is used wherever
  // the copy's own time is unknown.
  const links = outLinks(root);
  for (const copy of copies) {
    if (knownBuildTime(copy) !== null) continue;
    const link = links.find((l) => copy.artifact === l.path || copy.artifact.startsWith(l.path + path.sep));
    if (link) copy.builtAt = link.mtimeMs;
  }
  return copies;
}

/** `result*` symlinks directly under `root`, with the time each was written. */
function outLinks(root: string): Array<{ path: string; mtimeMs: number }> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of safeReaddir(root)) {
    if (!/^result/.test(name)) continue;
    const p = path.join(root, name);
    try {
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink() && isKnownTime(st.mtimeMs)) out.push({ path: p, mtimeMs: st.mtimeMs });
    } catch {
      /* a link we cannot stat dates nothing */
    }
  }
  return out;
}

/**
 * Every place a Basecamp install could be, on this platform.
 *
 * One implementation, because there were three and they disagreed: only this
 * one knew the macOS locations, so dependency staging and `doctor` were
 * Linux-only. A macOS author got a hard error reading "Looked in this repo,
 * its parent, and your Basecamp install", which was false because it had not,
 * and a doctor that said an installed dependency was not there.
 *
 * $LOGOS_USER_DIR wins when set; it is Basecamp's own override.
 *
 * The platform and home are parameters so both branches can be asserted from
 * either host. Reading `process.platform` directly, the darwin branch was
 * executed by nothing at all: CI runs ubuntu only, and the one test covering
 * it asserted the Linux list when it was not on a Mac, so it would have passed
 * with the darwin code deleted, while an archived task recorded the coverage
 * as done.
 *
 * Lives here rather than in session.ts because discovery needs it to tell an
 * installed copy from a local one, and session.ts already imports this file.
 */
export function basecampUserDirs(
  platform: string = process.platform,
  home: string = process.env.HOME ?? os.homedir(),
): string[] {
  const perPlatform =
    platform === "darwin"
      ? ["Library/Application Support/Logos/LogosBasecampDev", "Library/Application Support/Logos/LogosBasecamp"]
      : [".local/share/Logos/LogosBasecampDev", ".local/share/Logos/LogosBasecamp"];
  return [
    process.env.LOGOS_USER_DIR,
    ...perPlatform.map((rel) => path.join(home, rel)),
    // Kept for a developer who moved between platforms, or a shared checkout.
    ...(platform === "darwin"
      ? [".local/share/Logos/LogosBasecampDev", ".local/share/Logos/LogosBasecamp"].map((r) => path.join(home, r))
      : []),
  ].filter((d): d is string => Boolean(d));
}

/** The user-dirs that exist, resolved, for comparing against a copy's real path. */
function realUserDirs(): string[] {
  const out: string[] = [];
  for (const d of basecampUserDirs()) {
    try {
      out.push(fs.realpathSync(d));
    } catch {
      /* not on this machine */
    }
  }
  return out;
}

/**
 * "installed" when the copy's real path lies under a Basecamp user-dir.
 *
 * Decided from the path and not from which search found it: running from
 * inside an install makes "found where you pointed" and "installed" the same
 * directory, and a label that depended on the caller would say both.
 */
function provenanceOf(artifact: string, installedRoots: string[]): Provenance {
  let real: string;
  try {
    real = fs.realpathSync(artifact);
  } catch {
    real = path.resolve(artifact);
  }
  return installedRoots.some((r) => real === r || real.startsWith(r + path.sep)) ? "installed" : "local";
}

/**
 * Can Basecamp actually load this directory if we copy it into a user-dir?
 *
 * Staging is a plain copy, so a directory is only usable if it CONTAINS what
 * its manifest promises. A source checkout promises the same things a built
 * plugin does — `view: qml/Main.qml`, `main: "zonescan_lite_plugin"` — and
 * contains neither, because both are build outputs. Copying one yields a
 * user-dir full of CMakeLists.txt and .clang-format that Basecamp silently
 * declines to list, which is indistinguishable from a hang.
 *
 * Three independent promises, each checked only when it is actually made:
 *
 *   view          a ui_qml plugin's entry QML must be at the declared path
 *   main (string) a source-shaped manifest names a library that must exist
 *   main (map)    a built manifest names one per variant; at least one must exist
 *
 * `main: {}` is not a promise — it is how a pure-QML plugin says "no native
 * library" — so it must never be treated as a missing one.
 */
function withCompleteness(m: AppManifest, dir: string): { incomplete?: string } {
  if (!LOADABLE_TYPES.has(m.type)) {
    return { incomplete: `has type "${m.type}", which Basecamp does not load from a user-dir` };
  }

  const missing: string[] = [];

  if (m.type === "ui_qml" && typeof m.view === "string" && m.view.length > 0) {
    if (!fs.existsSync(path.join(dir, m.view))) missing.push(`its view "${m.view}"`);
  }

  const main = m.main;
  if (typeof main === "string" && main.length > 0) {
    // A bare name; the packager decides the extension per platform.
    const found = [".so", ".dylib", ".dll", ""].some((ext) => fs.existsSync(path.join(dir, main + ext)));
    if (!found) missing.push(`its library "${main}"`);
  } else if (main && typeof main === "object") {
    const entries = Object.entries(main);
    if (entries.length > 0 && !entries.some(([, lib]) => fs.existsSync(path.join(dir, lib)))) {
      missing.push(`its library "${[...new Set(entries.map(([, l]) => l))].join(" / ")}"`);
    }
  }

  if (missing.length === 0) return {};
  const hasBuildFiles = ["CMakeLists.txt", "flake.nix", "Justfile", "src"].some((f) =>
    fs.existsSync(path.join(dir, f)),
  );
  return {
    incomplete:
      `declares ${missing.join(" and ")}, which ${missing.length > 1 ? "are" : "is"} not in ${dir}` +
      (hasBuildFiles ? " — this looks like a source checkout, so build it and point at the output" : ""),
  };
}

/**
 * Does the package contain what its manifest promises?
 *
 * The directory rules cannot be reused: an .lgx keeps its payload under
 * variants/<platform>/, so `view` and `main` are relative to that, not to the
 * archive root. Without this an .lgx was always considered complete, and a
 * bundle holding nothing but manifest.json outranked a fully built directory —
 * reintroducing, through the packaged path, precisely the failure the directory
 * rules exist to prevent.
 */
function lgxCompleteness(file: string, m: AppManifest): { incomplete?: string } {
  const names = readTarGz(file).map((e) => e.name.replace(/^\.\//, ""));
  if (names.length === 0) return { incomplete: `${path.basename(file)} could not be read as a .lgx archive` };

  const payload = names.filter((n) => n.startsWith("variants/")).map((n) => n.split("/").slice(2).join("/"));
  const has = (rel: string) => payload.includes(rel);

  const missing: string[] = [];
  if (m.type === "ui_qml" && typeof m.view === "string" && m.view.length > 0 && !has(m.view)) {
    missing.push(`its view "${m.view}"`);
  }
  const main = m.main;
  if (typeof main === "string" && main.length > 0) {
    if (![".so", ".dylib", ".dll", ""].some((ext) => has(main + ext))) missing.push(`its library "${main}"`);
  } else if (main && typeof main === "object") {
    const entries = Object.values(main);
    if (entries.length > 0 && !entries.some((lib) => has(lib))) {
      missing.push(`its library "${[...new Set(entries)].join(" / ")}"`);
    }
  }
  if (missing.length === 0) return {};
  return { incomplete: `${path.basename(file)} declares ${missing.join(" and ")}, which is not inside the package` };
}

/** Newest mtime under `target`, bounded so a huge tree cannot stall discovery. */
function newestMtime(target: string, budget = 400): number {
  let newest = 0;
  let seen = 0;
  const walk = (dir: string): void => {
    if (seen > budget) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen++ > budget) return;
      const full = path.join(dir, e.name);
      try {
        if (e.isDirectory()) {
          walk(full);
        } else {
          const m = fs.statSync(full).mtimeMs;
          if (m > newest) newest = m;
        }
      } catch {
        /* unreadable entries do not affect freshness */
      }
    }
  };
  try {
    const st = fs.statSync(target);
    if (st.isFile()) return st.mtimeMs;
  } catch {
    return 0;
  }
  walk(target);
  return newest;
}

/**
 * A build time, or null when it cannot be known.
 *
 * Zero means it was never read, and anything inside the first day after the
 * epoch is how a nix store normalises mtimes: "1970" is a property of the
 * store, not of the build. Every comparison and every formatter goes through
 * this, so an unknown time can never lose to a known one or be printed as an
 * age.
 */
export function knownBuildTime(app: Pick<DiscoveredApp, "builtAt">): number | null {
  return isKnownTime(app.builtAt) ? app.builtAt : null;
}

/** True for an epoch-ms time that means something. See knownBuildTime. */
export function isKnownTime(ms: number | null | undefined): ms is number {
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 86_400_000;
}

/**
 * Which of two copies of the same app to keep, and why the other one lost.
 *
 * One ordered comparison, used by discovery, by the dependency sweep and by
 * the widening to the Basecamp install alike. There were three, each with its
 * own idea of the order, and none knew which copies were installed.
 *
 *   1. a loadable build beats one missing its outputs
 *   2. a build (manifest.json) beats the source tree it came from
 *   3. a HIGHER VERSION beats a lower one, wherever each was found
 *   4. a local build beats an installed copy of the same version
 *   5. a newer build time wins, only when both times are known
 *   6. otherwise the incumbent, the copy found first, stays
 *
 * `reason` is why the loser lost, whichever side that was: the candidate when
 * `wins` is false, the incumbent when it is true.
 *
 * Rule 4 is the one that was missing. An installed copy used to beat a fresh
 * local build of the same version whenever its mtime was newer, and a nix
 * `result/*.lgx` always reads the epoch, so a run staged the install and its
 * verdict was about bytes nobody had just built.
 */
export function compareCopies(
  candidate: DiscoveredApp,
  incumbent: DiscoveredApp | undefined,
): { wins: boolean; reason: PassReason | null } {
  if (!incumbent) return { wins: true, reason: null };
  if (Boolean(incumbent.incomplete) !== Boolean(candidate.incomplete)) {
    return { wins: !candidate.incomplete, reason: "incomplete" };
  }
  // A build beats the repo it came from, whatever the clock says. Nix
  // normalises every store timestamp to the epoch, so a freshly built
  // `result/*.lgx` reports 1970 while the source beside it reports today, and a
  // recency tiebreak chose the SOURCE every time. Staging a source checkout
  // produces a directory with `metadata.json` and no `manifest.json`, which
  // Basecamp silently declines to list. Observed on a nix-built ldex_ui.
  if (Boolean(candidate.built) !== Boolean(incumbent.built)) {
    return { wins: Boolean(candidate.built), reason: "source-only" };
  }
  const byVersion = compareVersions(candidate.manifest.version, incumbent.manifest.version);
  if (byVersion !== 0) return { wins: byVersion > 0, reason: "lower-version" };
  const mine = candidate.provenance ?? "local";
  const theirs = incumbent.provenance ?? "local";
  if (mine !== theirs) return { wins: mine === "local", reason: "installed" };
  const a = knownBuildTime(candidate);
  const b = knownBuildTime(incumbent);
  if (a !== null && b !== null) return { wins: a > b, reason: "older" };
  return { wins: false, reason: "untimed-tie" };
}

/**
 * Which of two copies of the same app to keep.
 *
 * Kept for its callers and its export: it is compareCopies without the reason.
 * Version comes before mtime because a timestamp lies in both directions here:
 * nix normalises store mtimes to the epoch, and a stale package sitting in
 * dist/ carries whatever date it was copied. A real case: medusa/dist held a
 * 0.2.0 package while 0.3.0 was installed, and going on mtime alone tested
 * 0.2.0 — whose wallet CLI resolution differs, producing a failure that
 * belonged to sitometres rather than to the app.
 */
export function better(candidate: DiscoveredApp, incumbent: DiscoveredApp | undefined): boolean {
  return compareCopies(candidate, incumbent).wins;
}

/** Library suffixes a bare `main` may be completed with, per platform. */
const LIB_EXTS = [".so", ".dylib", ".dll", ""];

/**
 * The file Basecamp loads from a copy of this app, for the staging hash.
 *
 * `has(rel)` answers whether a path relative to the app's root exists in the
 * copy being hashed (a directory, or a variant's payload inside a `.lgx`), so
 * the one rule serves the staged copy and the prediction of it alike.
 *
 *   main: "x"           the library, completed with the platform's suffix
 *   main: {variant: x}  the chosen variant's library; when no key matches,
 *                       every distinct library in the map that exists
 *   main: {} or none    a pure-QML plugin has no library, so its `view`
 */
export function mainEntryOf(
  manifest: AppManifest,
  variant: string,
  has: (rel: string) => boolean,
): Array<{ kind: "library" | "view"; rel: string }> {
  const main = manifest.main;
  if (typeof main === "string" && main.length > 0) {
    for (const ext of LIB_EXTS) if (has(main + ext)) return [{ kind: "library", rel: main + ext }];
    return [];
  }
  if (main && typeof main === "object" && Object.keys(main).length > 0) {
    const chosen = main[variant];
    if (typeof chosen === "string" && chosen.length > 0 && has(chosen)) return [{ kind: "library", rel: chosen }];
    const libs = [...new Set(Object.values(main).filter((l): l is string => typeof l === "string" && l.length > 0))];
    return libs.filter(has).map((rel) => ({ kind: "library" as const, rel }));
  }
  if (manifest.type === "ui_qml" && typeof manifest.view === "string" && manifest.view.length > 0 && has(manifest.view)) {
    return [{ kind: "view", rel: manifest.view }];
  }
  return [];
}

/**
 * Does `version` fall in `range`? Null when either cannot be read.
 *
 * The npm-style forms a manifest's object dependency uses: an exact version,
 * `^` and `~`, comparators (`>=1.2 <2`), `x` wildcards, and `||` between
 * alternatives. Pre-release tags are ignored: a range here chooses between
 * copies on disk, it does not resolve a registry.
 */
export function satisfiesRange(version: string | undefined, range: string): boolean | null {
  const v = parseSemver(version);
  if (!v) return null;
  const alternatives = range.split("||").map((r) => r.trim());
  let readable = false;
  for (const alt of alternatives) {
    const comparators = alt.length === 0 ? ["*"] : alt.split(/\s+/);
    let all = true;
    let ok = true;
    for (const c of comparators) {
      const r = comparatorHolds(v, c);
      if (r === null) {
        ok = false;
        break;
      }
      if (!r) all = false;
    }
    if (!ok) continue;
    readable = true;
    if (all) return true;
  }
  return readable ? false : null;
}

type Semver = [number, number, number];

function parseSemver(v: string | undefined): Semver | null {
  if (!v) return null;
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

function cmp(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]! ? 1 : -1;
  return 0;
}

function comparatorHolds(v: Semver, raw: string): boolean | null {
  if (raw === "*" || raw === "x" || raw === "X") return true;
  const m = /^(\^|~|>=|<=|>|<|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+].*)?$/.exec(raw);
  if (!m) return null;
  const op = m[1] ?? "";
  const wild = (p: string | undefined) => p === undefined || /^[xX*]$/.test(p);
  const parts = [m[2], m[3], m[4]];
  const fixed = parts.findIndex(wild);
  const known = fixed === -1 ? 3 : fixed;
  const base: Semver = [0, 1, 2].map((i) => (i < known ? Number(parts[i]) : 0)) as Semver;
  if (known === 0) return true;
  // A partial version is the range of everything it names: 1.2 is >=1.2.0 <1.3.0.
  const upperOf = (k: number): Semver =>
    k === 1 ? [base[0] + 1, 0, 0] : k === 2 ? [base[0], base[1] + 1, 0] : [base[0], base[1], base[2] + 1];
  switch (op) {
    case "":
    case "=":
      return cmp(v, base) >= 0 && cmp(v, upperOf(known)) < 0;
    case "^": {
      const upper: Semver = base[0] > 0 || known === 1 ? [base[0] + 1, 0, 0] : base[1] > 0 || known === 2 ? [0, base[1] + 1, 0] : [0, 0, base[2] + 1];
      return cmp(v, base) >= 0 && cmp(v, upper) < 0;
    }
    case "~":
      return cmp(v, base) >= 0 && cmp(v, known === 1 ? [base[0] + 1, 0, 0] : [base[0], base[1] + 1, 0]) < 0;
    case ">=":
      return cmp(v, base) >= 0;
    case ">":
      return known === 3 ? cmp(v, base) > 0 : cmp(v, upperOf(known)) >= 0;
    case "<=":
      return known === 3 ? cmp(v, base) <= 0 : cmp(v, upperOf(known)) < 0;
    case "<":
      return cmp(v, base) < 0;
  }
  return null;
}

/** Dotted-numeric compare; 0 when either side has no usable version. */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  const pa = a.split(/[.\-+]/).map(Number);
  const pb = b.split(/[.\-+]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function slotFor(m: AppManifest): "plugins" | "modules" {
  return m.type === "core" ? "modules" : "plugins";
}

/** Read manifest.json out of a .lgx (gzipped tar) without unpacking it. */
export function readLgxManifest(file: string): AppManifest | null {
  const entries = readTarGz(file, (name) => name === "manifest.json" || name.endsWith("/manifest.json"));
  const first = entries[0];
  if (!first) return null;
  try {
    // Through the same normaliser as a manifest read off disk. This was a
    // second, hand-rolled copy of it, and it drifted the way a copy does: when
    // normaliseManifest learned to drop a field whose type its declaration does
    // not honour, a .lgx still handed `"version": 2` straight through, and
    // compareVersions still died on it with `a.split is not a function`.
    const raw = JSON.parse(first.data.toString("utf8")) as Record<string, unknown>;
    return normaliseManifest(raw, file);
  } catch {
    return null;
  }
}

// --- minimal tar.gz reader -------------------------------------------------
//
// A .lgx is `manifest.json` plus `variants/<platform>/…`. Rather than take a
// tar dependency we read the 512-byte headers directly; the format is fixed
// and we only ever need regular files.

export interface TarEntry {
  name: string;
  data: Buffer;
}

export function readTarGz(file: string, filter: (name: string) => boolean = () => true): TarEntry[] {
  let buf: Buffer;
  try {
    buf = zlib.gunzipSync(fs.readFileSync(file));
  } catch {
    return [];
  }
  const out: TarEntry[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let name = cstr(header.subarray(0, 100));
    const prefix = cstr(header.subarray(345, 500));
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(cstr(header.subarray(124, 136)).trim() || "0", 8) || 0;
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const dataStart = off + 512;
    const dataEnd = dataStart + size;

    if (typeFlag === "L") {
      // GNU long-name extension: the next header's real name lives here.
      longName = cstr(buf.subarray(dataStart, dataEnd));
    } else {
      if (longName) {
        name = longName;
        longName = null;
      }
      if ((typeFlag === "0" || typeFlag === "\0") && filter(name)) {
        out.push({ name, data: buf.subarray(dataStart, dataEnd) });
      }
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

function cstr(b: Buffer): string {
  const i = b.indexOf(0);
  return b.subarray(0, i === -1 ? b.length : i).toString("utf8");
}

// --- filesystem helpers ----------------------------------------------------

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(p: string): string[] {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}

function childDirs(p: string): string[] {
  return safeReaddir(p)
    .filter((n) => !n.startsWith(".") || n === ".")
    .filter((n) => !IGNORED_DIRS.has(n))
    .map((n) => path.join(p, n))
    .filter(isDir);
}

// --- locating Basecamp -----------------------------------------------------

export interface BasecampBinary {
  path: string;
  /** How we found it, for the report header and for `sitometres doctor`. */
  origin: string;
  /** False means UI driving is impossible: the inspector was compiled out. */
  inspectorEnabled: boolean;
}

/**
 * Candidate Basecamp binaries, best first.
 *
 * The inspector is a COMPILE-TIME feature (ENABLE_QML_INSPECTOR) and is off in
 * the shipping AppImage/DMG, so finding a binary is not enough — we probe it
 * for the inspector's own log strings and refuse to pretend otherwise.
 */
/**
 * The remembered path that was unusable, when that is why discovery restarted.
 *
 * Carried out-of-band so the search can continue AND the reason can still be
 * reported: a fallback that hides why it fell back leaves the developer editing
 * the wrong thing.
 */
export let staleRememberedBasecamp: string | null = null;

/** A file that exists and this user may execute. */
export function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function locateBasecamp(explicit?: string): BasecampBinary[] {
  staleRememberedBasecamp = null;
  const candidates: Array<{ path: string; origin: string }> = [];
  // Executable, not merely present: a path without the execute bit reaches
  // spawn() and raises an 'error' event, which is not a diagnostic anyone can act on.
  const push = (p: string | undefined, origin: string) => {
    if (p && isExecutableFile(p)) candidates.push({ path: p, origin });
  };

  // An explicit choice is exclusive. Silently falling back to some other
  // binary would run the tests against something the developer did not pick.
  const config = loadConfig();
  const chosen =
    explicit ?? process.env.SITOMETRES_BASECAMP ?? process.env.LOGOS_BASECAMP_BIN ?? config.basecamp;
  if (chosen) {
    const origin = explicit
      ? "--basecamp"
      : process.env.SITOMETRES_BASECAMP
        ? "$SITOMETRES_BASECAMP"
        : process.env.LOGOS_BASECAMP_BIN
          ? "$LOGOS_BASECAMP_BIN"
          : "remembered (sitometres doctor --set-basecamp)";
    if (isExecutableFile(chosen)) {
      return [{ path: chosen, origin, inspectorEnabled: hasInspector(chosen) }];
    }
    // A REMEMBERED path that has gone stale must not silently stop discovery.
    // It used to `return []`, so a machine with a perfectly good Basecamp in
    // the usual place reported "No Basecamp binary found" forever, and nothing
    // ever named the config file that caused it. An explicit choice
    // (--basecamp, an env var) still wins and still fails loudly: silently
    // running something the developer did not pick would be worse.
    if (!origin.startsWith("remembered")) return [];
    staleRememberedBasecamp = chosen;
    // ...and fall through to the generic search below.
  }

  // Generic search: a checkout named logos-basecamp somewhere at or above the
  // working directory, or beside it. Guessing at somebody's home-directory
  // layout does not generalise, so anything else is configured, not divined.
  const home = os.homedir();
  const roots: string[] = [];
  if (process.env.LDEX_BASECAMP_DIR) roots.push(process.env.LDEX_BASECAMP_DIR);
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    roots.push(dir, path.join(dir, "logos-basecamp"));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  roots.push(path.join(home, "logos-basecamp"));

  for (const root of roots) {
    push(path.join(root, "result/bin/LogosBasecamp"), `${root}/result (nix build)`);
    push(path.join(root, "result-bundle/bin/LogosBasecamp"), `${root}/result-bundle`);
  }
  push(path.join(home, ".local/bin/logos-basecamp"), "~/.local/bin");

  const seen = new Set<string>();
  const out: BasecampBinary[] = [];
  for (const c of candidates) {
    const real = fs.realpathSync(c.path);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push({ path: c.path, origin: c.origin, inspectorEnabled: hasInspector(c.path) });
  }
  return out;
}

/**
 * Does this build have the QML inspector compiled in?
 *
 * The nix wrapper script execs a sibling dot-file that holds the real ELF, so
 * we scan the named path and every spelling of that sibling for the
 * inspector's literal log strings.
 *
 * All three spellings are real and all three are on this machine:
 *   `.<base>`          `.#default`: bin/.LogosBasecamp, a 1.1 MB ELF beside a
 *                      4 KB sh wrapper.
 *   `.<base>.elf`      `.#bin-bundle-dir-inspector` — the build README.md:95
 *                      and SKILL.md:28 tell you to make. Its wrapper says
 *                      `REAL="$SELF_DIR/.$BASE.elf"` and the bundle ships no
 *                      extensionless name at all. Missing this spelling is why
 *                      a bundle with the inspector compiled in was reported as
 *                      having none.
 *   `.<base>-wrapped`  what nixpkgs `makeWrapper`/`wrapProgram` emits, e.g.
 *                      logos-liblogos/bin/.logos_host-wrapped.
 *
 * Probing is anchored to the binary we were ASKED about: each target is an
 * exact name derived from it, never a glob. `bin/.*.elf` would let a sibling
 * component's inspector (`.ui-host.elf`) answer for a Basecamp that has none.
 *
 * binPath is resolved first because the sibling lives beside the real file. A
 * `result/` directory symlink resolves through dirname anyway, but a symlink
 * to the binary itself does not, and locateBasecamp passes unresolved paths.
 */
export function hasInspector(binPath: string): boolean {
  // realpathSync throws on a dangling or missing path; the caller's contract is
  // that a path we cannot read answers no rather than throwing.
  let resolved = binPath;
  try {
    resolved = fs.realpathSync(binPath);
  } catch {
    /* fall back to the path as given */
  }
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const targets = [
    resolved,
    path.join(dir, `.${base}`),
    path.join(dir, `.${base}.elf`),
    path.join(dir, `.${base}-wrapped`),
  ];
  const needle = Buffer.from("[QmlInspector] Inspector server listening on port", "utf8");
  for (const t of targets) {
    try {
      const st = fs.statSync(t);
      if (!st.isFile() || st.size < 1024) continue;
      if (searchFile(t, needle)) return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

/** Chunked substring search so we never read a 100 MB binary into memory. */
function searchFile(file: string, needle: Buffer): boolean {
  const CHUNK = 1 << 20;
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.allocUnsafe(CHUNK + needle.length);
    let carry = 0;
    let pos = 0;
    for (;;) {
      const read = fs.readSync(fd, buf, carry, CHUNK, pos);
      if (read <= 0) return false;
      pos += read;
      const end = carry + read;
      if (buf.subarray(0, end).includes(needle)) return true;
      carry = Math.min(needle.length - 1, end);
      buf.copy(buf, 0, end - carry, end);
    }
  } finally {
    fs.closeSync(fd);
  }
}
