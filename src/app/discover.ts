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
import { type AppManifest, type LoadedManifest, readManifestDir, uiLabel } from "./manifest.js";

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
   */
  builtAt: number;
}

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
]);

/**
 * Look for apps in and under `root`. Shallow by design — a couple of levels is
 * enough for every real layout, and deep walks over a Nix-heavy repo are slow.
 */
export function discoverApps(root: string): DiscoveredApp[] {
  const found = new Map<string, DiscoveredApp>();

  const addDir = (dir: string, slot: "plugins" | "modules", origin: string) => {
    const loaded = readManifestDir(dir);
    if (!loaded) return;
    const key = loaded.manifest.name;
    if (BASECAMP_BUILTINS.has(loaded.manifest.name)) return;
    const candidate: DiscoveredApp = {
      manifest: loaded.manifest,
      artifact: dir,
      form: "dir",
      built: path.basename(loaded.source) === "manifest.json",
      slot: slot ?? slotFor(loaded.manifest),
      origin,
      label: uiLabel(loaded.manifest),
      ...withCompleteness(loaded.manifest, dir),
      builtAt: newestMtime(dir),
    };
    if (better(candidate, found.get(key))) found.set(key, candidate);
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
    addCandidate(found, {
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
    addCandidate(found, {
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
      addCandidate(found, {
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

  // UI plugins first: those are the ones a UI test can actually drive.
  return [...found.values()].sort((a, b) => Number(b.slot === "plugins") - Number(a.slot === "plugins"));
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
 * Which of two copies of the same app to keep.
 *
 * Order matters, and mtime is the weakest of the three signals:
 *
 *   1. a loadable build beats one missing its outputs
 *   2. a HIGHER VERSION beats a lower one
 *   3. only then, newer mtime
 *
 * Version comes before mtime because a timestamp lies in both directions here:
 * nix normalises store mtimes to the epoch, and a stale package sitting in
 * dist/ carries whatever date it was copied. A real case: medusa/dist held a
 * 0.2.0 package while 0.3.0 was installed, and going on mtime alone tested
 * 0.2.0 — whose wallet CLI resolution differs, producing a failure that
 * belonged to sitometres rather than to the app.
 */
export function better(candidate: DiscoveredApp, incumbent: DiscoveredApp | undefined): boolean {
  if (!incumbent) return true;
  if (Boolean(incumbent.incomplete) !== Boolean(candidate.incomplete)) return !candidate.incomplete;
  // A build beats the repo it came from, whatever the clock says. Nix
  // normalises every store timestamp to the epoch, so a freshly built
  // `result/*.lgx` reports 1970 while the source beside it reports today — and
  // the recency tiebreak below therefore chose the SOURCE every time. Staging a
  // source checkout produces a directory with `metadata.json` and no
  // `manifest.json`, which Basecamp silently declines to list: the run then
  // fails with "sidebar has not rendered <app>", which reads like the app's
  // fault and is not. Observed on a nix-built ldex_ui.
  if (candidate.built !== incumbent.built) return candidate.built;
  const byVersion = compareVersions(candidate.manifest.version, incumbent.manifest.version);
  if (byVersion !== 0) return byVersion > 0;
  return candidate.builtAt > incumbent.builtAt;
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

function addCandidate(found: Map<string, DiscoveredApp>, candidate: DiscoveredApp): void {
  if (BASECAMP_BUILTINS.has(candidate.manifest.name)) return;
  if (better(candidate, found.get(candidate.manifest.name))) found.set(candidate.manifest.name, candidate);
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
    const raw = JSON.parse(first.data.toString("utf8")) as Record<string, unknown>;
    if (typeof raw.name !== "string") return null;
    return {
      ...raw,
      name: raw.name,
      type: typeof raw.type === "string" ? raw.type : "unknown",
      dependencies: Array.isArray(raw.dependencies)
        ? raw.dependencies.filter((d): d is string => typeof d === "string")
        : [],
    } as AppManifest;
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
 * we scan both for the inspector's literal log strings.
 */
export function hasInspector(binPath: string): boolean {
  const dir = path.dirname(binPath);
  const base = path.basename(binPath);
  const targets = [binPath, path.join(dir, `.${base}`)];
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
