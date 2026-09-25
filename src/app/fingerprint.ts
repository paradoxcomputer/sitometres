// ---------------------------------------------------------------------------
// Which bytes a run tested.
//
// A verdict is only worth something if it can be tied to a build. The run
// header used to name the app under test and nothing else: no dependency, no
// hash. So when an installed copy of a dependency quietly won over the build a
// developer had just made, every line the user read still looked right, and
// the only way to catch it was a script that hashed whatever each sandbox had
// loaded.
//
// Each staged app now gets a record: which artifact it came from, whether that
// copy was local or installed, how old it is, and a sha256 of the file
// Basecamp actually loads from it. The same code hashes the staged copy (for
// the run) and predicts it from the source (for `doctor`), so the two cannot
// be worded or computed differently.
//
// A hash identifies a build. It does not vouch for one: nothing here checks a
// signature or a package root hash.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type DiscoveredApp, knownBuildTime, mainEntryOf, type Provenance, readTarGz } from "./discover.js";
import { chooseVariant, lgxVariants } from "./userdir.js";

export interface StagedRecord {
  name: string;
  /** The manifest's own version, or null when it declares none. */
  version: string | null;
  slot: "plugins" | "modules";
  /** The exact artifact this copy was staged from, as an absolute path. */
  artifact: string;
  form: "dir" | "lgx";
  provenance: Provenance;
  /** Epoch ms, or null when the build time is unknown. See knownBuildTime. */
  builtAt: number | null;
  /**
   * What was hashed: the main library for the variant staged, or the declared
   * `view` for a plugin with no library. `path` is relative to the app's
   * directory inside the user-dir, so it names the file Basecamp loads.
   */
  hashes: Array<{ kind: "library" | "view"; path: string; sha256: string }>;
  /** A one-line note about how this copy was chosen, when one is worth reading. */
  note?: string;
}

export function sha256(data: Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * The record for a copy already staged into `userDirRoot`.
 *
 * Hashes the staged file, never the source: hashing the source here would hide
 * the one failure worth catching, which is staging writing something other
 * than what was chosen. The variant is the one unpacking recorded beside the
 * copy, when it recorded one.
 */
export function recordStaged(app: DiscoveredApp, userDirRoot: string, variant: string): StagedRecord {
  const dir = path.join(userDirRoot, app.slot, app.manifest.name);
  const chosen = readVariantFile(dir) ?? variant;
  const entries = mainEntryOf(app.manifest, chosen, (rel) => isFile(path.join(dir, rel)));
  const hashes: StagedRecord["hashes"] = [];
  for (const e of entries) {
    try {
      hashes.push({ kind: e.kind, path: e.rel, sha256: sha256(fs.readFileSync(path.join(dir, e.rel))) });
    } catch {
      /* a file that vanished between the check and the read is simply not hashed */
    }
  }
  return base(app, hashes);
}

/**
 * The record a run WOULD produce for this copy, without staging it.
 *
 * For a directory that is the source file, which staging copies verbatim. For
 * a `.lgx` it is the tar entry unpacking would write for the chosen variant,
 * chosen by the same function unpacking uses. Throws where unpacking would,
 * for a package whose variants leave the choice to the user.
 */
export function predictStaged(app: DiscoveredApp, variant: string): StagedRecord {
  if (app.form === "lgx") {
    const entries = readTarGz(app.artifact);
    const chosen = chooseVariant(lgxVariants(entries), variant, app.artifact);
    const payload = new Map<string, Buffer>();
    if (chosen) {
      const prefix = `variants/${chosen}/`;
      for (const e of entries) {
        const name = e.name.replace(/^\.\//, "");
        if (name.startsWith(prefix) && name.length > prefix.length) payload.set(name.slice(prefix.length), e.data);
      }
    }
    const hashes = mainEntryOf(app.manifest, chosen, (rel) => payload.has(rel)).map((e) => ({
      kind: e.kind,
      path: e.rel,
      sha256: sha256(payload.get(e.rel)!),
    }));
    return base(app, hashes);
  }
  const dir = app.artifact;
  const chosen = readVariantFile(dir) ?? variant;
  const hashes: StagedRecord["hashes"] = [];
  for (const e of mainEntryOf(app.manifest, chosen, (rel) => isFile(path.join(dir, rel)))) {
    try {
      hashes.push({ kind: e.kind, path: e.rel, sha256: sha256(fs.readFileSync(path.join(dir, e.rel))) });
    } catch {
      /* unreadable: nothing to predict */
    }
  }
  return base(app, hashes);
}

/**
 * An artifact path the way the header and `doctor` print it.
 *
 * Relative to where the command was run when that is close by, since that is
 * how a developer thinks of `result/` and `../sibling/`. Otherwise absolute,
 * with $HOME shortened, because ten `../` say nothing.
 */
export function displayArtifact(p: string, cwd: string = process.cwd()): string {
  const abs = path.resolve(p);
  const rel = path.relative(cwd, abs);
  if (rel === "") return ".";
  const ups = rel.split(path.sep).filter((part) => part === "..").length;
  if (!path.isAbsolute(rel) && ups <= 2) return rel;
  const home = process.env.HOME ?? os.homedir();
  return home && (abs === home || abs.startsWith(home + path.sep)) ? "~" + abs.slice(home.length) : abs;
}

function base(app: DiscoveredApp, hashes: StagedRecord["hashes"]): StagedRecord {
  return {
    name: app.manifest.name,
    version: typeof app.manifest.version === "string" && app.manifest.version ? app.manifest.version : null,
    slot: app.slot,
    artifact: path.resolve(app.artifact),
    form: app.form,
    provenance: app.provenance ?? "local",
    builtAt: knownBuildTime(app),
    hashes,
  };
}

/** The one-line `variant` file unpacking writes beside an installed plugin. */
function readVariantFile(dir: string): string | null {
  try {
    const v = fs.readFileSync(path.join(dir, "variant"), "utf8").trim();
    return v || null;
  } catch {
    return null;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
