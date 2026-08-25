// ---------------------------------------------------------------------------
// The version, read from the package manifest.
//
// It used to be a literal here as well as in package.json, and nothing kept
// them equal: `npm version patch` bumped one and left this one behind, so
// `--version` and every machine report kept claiming the old number. One
// source, resolved relative to this file so it works from dist/ and from a
// global install alike.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function readVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/version.js -> ../package.json; src/version.ts -> ../package.json.
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const raw = readFileSync(path.join(here, rel), "utf8");
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      // Match the package, not one particular spelling of its name: the guard
      // exists to reject a consumer's manifest, and pinning the literal
      // "sitometres" meant scoping the package to @paradoxcomputer silently
      // returned the unknown sentinel from every installed copy.
      const name = parsed.name ?? "";
      const ours = name === "sitometres" || name.endsWith("/sitometres");
      if (ours && parsed.version) return parsed.version;
    } catch {
      /* try the next candidate */
    }
  }
  return "0.0.0-unknown";
}

export const VERSION = readVersion();
