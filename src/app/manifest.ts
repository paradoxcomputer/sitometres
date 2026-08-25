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
  /** Core modules this app needs loaded before it will work. */
  dependencies: string[];
  /**
   * Built manifests map variant -> shared library. An EMPTY map is meaningful:
   * it means the plugin is pure QML with no C++ view module, so Basecamp runs
   * it in-process against the `logos` bridge instead of spawning a ui-host.
   */
  main?: Record<string, string> | string;
  [key: string]: unknown;
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
    const manifest = normalise(raw, p);
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

function normalise(raw: unknown, source: string): AppManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) return null;
  const deps = Array.isArray(o.dependencies) ? o.dependencies.filter((d): d is string => typeof d === "string") : [];
  const m: AppManifest = {
    ...o,
    name: o.name,
    type: typeof o.type === "string" ? o.type : "unknown",
    dependencies: deps,
  };
  if (typeof o.version === "string") m.version = o.version;
  if (typeof o.display_name === "string") m.display_name = o.display_name;
  if (typeof o.view === "string") m.view = o.view;
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
