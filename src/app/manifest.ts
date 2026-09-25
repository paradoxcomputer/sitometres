// ---------------------------------------------------------------------------
// The app-under-test's own declaration of itself.
//
// A Logos package carries two descriptors and they are not interchangeable:
//   metadata.json — the SOURCE manifest a developer edits (build recipe under
//                   "nix", codegen, extra sources).
//   manifest.json — the BUILT manifest the packager emits: adds "main" as a
//                   per-variant map, "hashes", "manifestVersion".
// Installed plugins carry both plus a one-line `variant` file naming the
// platform variant that was unpacked (e.g. "linux-amd64-dev").
//
// sitometres reads whichever is present, preferring manifest.json because it
// is what Basecamp itself loads.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

export type AppType = "ui_qml" | "core" | (string & {});

export interface AppManifest {
  name: string;
  version?: string;
  /** "ui_qml" for something with a UI, "core" for a headless backend module. */
  type: AppType;
  /** Label Basecamp shows in the sidebar/dock. Falls back to `name`. */
  display_name?: string;
  description?: string;
  category?: string;
  icon?: string;
  /** Entry QML for ui_qml plugins, relative to the plugin root. */
  view?: string;
  /**
   * Core modules this app needs loaded before it will work, by name.
   *
   * A 0.3.0 manifest may write an entry as `{ name, version, signer }` rather
   * than a bare name; the name lands here either way, and the rest in
   * `dependencySpecs`.
   */
  dependencies: string[];
  /**
   * Modules the app uses when present and does without when not (0.3.0).
   * Staged when they can be found; never a reason to refuse a run.
   */
  optional_dependencies?: string[];
  /** The object-form dependency entries, with their version range and signer. */
  dependencySpecs?: DependencySpec[];
  /**
   * Built manifests map variant -> shared library. An EMPTY map is meaningful:
   * it means the plugin is pure QML with no C++ view module, so Basecamp runs
   * it in-process against the `logos` bridge instead of spawning a ui-host.
   */
  main?: Record<string, string> | string;
  [key: string]: unknown;
}

/** A dependency written as an object (Basecamp 0.3.0's readDependencyEntry). */
export interface DependencySpec {
  name: string;
  /** A version range, e.g. "^1.2". */
  version?: string;
  signer?: string;
}

/**
 * A dependency entry's name and constraints, or null when it is neither a
 * name nor an object with one. 0.2.2 read only the string form and skipped
 * the rest; 0.3.0 accepts both, so both are read here.
 */
function dependencyEntry(v: unknown): DependencySpec | null {
  if (typeof v === "string") return v.length > 0 ? { name: v } : null;
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) return null;
  const out: DependencySpec = { name: o.name };
  if (typeof o.version === "string" && o.version.length > 0) out.version = o.version;
  if (typeof o.signer === "string" && o.signer.length > 0) out.signer = o.signer;
  return out;
}

/** "tip_core ^1.2 (signer abc)", for a header line. */
export function describeDependency(name: string, m: AppManifest): string {
  const spec = m.dependencySpecs?.find((d) => d.name === name);
  if (!spec) return name;
  return [name, spec.version, spec.signer ? `(signer ${spec.signer})` : undefined].filter(Boolean).join(" ");
}

export interface LoadedManifest {
  manifest: AppManifest;
  /** Which file it came from. */
  source: string;
  /** Platform variant recorded alongside an installed plugin, if any. */
  variant?: string;
}

/**
 * Manifests that could not be parsed during this process's discovery passes.
 * Surfaced by `doctor` so a broken file is fixable rather than merely skipped.
 */
export const malformed: Array<{ file: string; reason: string }> = [];

export function readManifestDir(dir: string): LoadedManifest | null {
  for (const file of ["manifest.json", "metadata.json"]) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (err) {
      // Discovery walks whole directory trees, so one unrelated broken file
      // must not take the tool down with it. A stray manifest.json holding
      // invalid JSON anywhere under the search path used to abort every
      // command before it had even found the app.
      malformed.push({ file: p, reason: (err as Error).message });
      continue;
    }
    const manifest = normaliseManifest(raw, p);
    if (!manifest) continue;
    const out: LoadedManifest = { manifest, source: p };
    const variantFile = path.join(dir, "variant");
    if (fs.existsSync(variantFile)) {
      const v = fs.readFileSync(variantFile, "utf8").trim();
      if (v) out.variant = v;
    }
    return out;
  }
  return null;
}

/**
 * Turn parsed manifest JSON into an AppManifest, or null if it is not one.
 *
 * Exported because a .lgx carries its manifest inside a tarball and used to be
 * normalised by a second, hand-rolled copy of this logic in discover.ts - which
 * meant a fix applied here left that route still broken. One manifest, one
 * place that decides what it is.
 */
export function normaliseManifest(raw: unknown, source: string): AppManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) return null;
  const entries = (v: unknown): DependencySpec[] =>
    Array.isArray(v) ? v.map(dependencyEntry).filter((d): d is DependencySpec => d !== null) : [];
  const deps = entries(o.dependencies);
  const m: AppManifest = {
    ...o,
    name: o.name,
    type: typeof o.type === "string" ? o.type : "unknown",
    dependencies: [...new Set(deps.map((d) => d.name))],
  };
  const specs = deps.filter((d) => d.version !== undefined || d.signer !== undefined);
  if (specs.length > 0) m.dependencySpecs = specs;
  else delete m.dependencySpecs;
  if (o.optional_dependencies !== undefined) {
    const optional = [...new Set(entries(o.optional_dependencies).map((d) => d.name))].filter((n) => !m.dependencies.includes(n));
    if (optional.length > 0) m.optional_dependencies = optional;
    else delete m.optional_dependencies;
  }
  // The spread above carries arbitrary extra keys through on purpose: AppManifest
  // has an index signature, and a BUILT manifest ships `hashes`, `manifestVersion`
  // and more that nothing here declares. What it also did was pre-seed the
  // DECLARED optionals with whatever the JSON held, while the guards that stood
  // here only ever overwrote and never deleted - so `"version": 2` survived on a
  // field typed `string`. A number then reached compareVersions and took
  // discovery down with `a.split is not a function`, and reached esc(), which
  // lost BOTH machine artifacts of a run that had already passed. Neither needed
  // a malformed app: one stray manifest.json anywhere in the discovery sweep was
  // enough, and that is exactly how it was found.
  //
  // A manifest is somebody else's file. A declared type it does not honour is
  // dropped here, once, so every reader downstream can trust the type it was
  // promised instead of re-deriving that guard and forgetting it somewhere.
  for (const key of ["version", "display_name", "description", "category", "icon", "view"]) {
    if (typeof m[key] !== "string") delete m[key];
  }
  // `main` gets its own clause because it is the one declared field that is not
  // a string: a variant map, or a single library path. `null` is the spelling
  // that hurt - neither undefined nor a string, so isPureQml fell past both its
  // guards into `Object.keys(null)` and took down a boot that had already
  // launched Basecamp. An empty map is meaningful and must survive; an array is
  // not a variant map and must not.
  if (!(typeof m.main === "string" || (typeof m.main === "object" && m.main !== null && !Array.isArray(m.main)))) {
    delete m.main;
  }
  void source;
  return m;
}

/** The label Basecamp renders — what a click selector will actually see. */
export function uiLabel(m: AppManifest): string {
  return m.display_name && m.display_name.length > 0 ? m.display_name : m.name;
}

/** True for a plugin that runs in-process on the `logos` QML bridge. */
export function isPureQml(m: AppManifest): boolean {
  if (m.type !== "ui_qml") return false;
  if (m.main === undefined) return true;
  if (typeof m.main === "string") return m.main.length === 0;
  return Object.keys(m.main).length === 0;
}

/** True for a ui_qml plugin backed by a spawned ui-host process. */
export function isViewModule(m: AppManifest): boolean {
  return m.type === "ui_qml" && !isPureQml(m);
}
