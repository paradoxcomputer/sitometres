// ---------------------------------------------------------------------------
// Building the isolated --user-dir a test runs against.
//
// Basecamp's --user-dir (main.cpp:127-159, also settable as LOGOS_USER_DIR)
// re-roots plugins/, modules/, module_data/ and logs/ for one instance, which
// is what lets sitometres test an app without touching the developer's real
// Basecamp install and without a package catalog or any network.
//
// The staging recipe is a plain copy — the same one logos-basecamp's own
// doctests use: UI plugins under plugins/<name>/, core modules under
// modules/<name>/. A .lgx is unpacked to the same shape: manifest.json at the
// plugin root, the selected variants/<platform>/ tree flattened over it, and a
// one-line `variant` file recording which platform was chosen.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiscoveredApp } from "./discover.js";
import { reapDirOnExit, releaseDir, restoreOnExit } from "./lifecycle.js";
import { readTarGz } from "./discover.js";

export interface StagedUserDir {
  root: string;
  /** Apps copied in, by name. */
  staged: string[];
  /** True when we created it and may delete it again. */
  ephemeral: boolean;
  /**
   * Plugins and modules already present that this run did not stage.
   *
   * Only ever non-empty for a caller-supplied --user-dir. Basecamp will load
   * these too, so the run is not the pristine thing the header would otherwise
   * claim — it is reported rather than deleted.
   */
  foreign: string[];
  /**
   * Apps whose installed directory this run deleted and rewrote.
   *
   * Reported separately from `foreign` because the guarantee is the opposite
   * one. The header said only "<the others> (already installed, left alone)",
   * and README and --help both said a caller's --user-dir loses nothing — while
   * staging removed the destination of the app under test and every dependency,
   * unconditionally. Someone who points --user-dir at their real install is
   * entitled to know which of their installed plugins was overwritten.
   */
  replaced: string[];
  /**
   * Apps already staged at their destination, so nothing was copied.
   *
   * `installedApps()` discovers apps from the Basecamp user-dir itself, so
   * `--user-dir <that install>` resolves an app to the very directory staging
   * is about to remove. See stageUserDir.
   */
  inPlace: string[];
  /**
   * True when `cleanup()` will put a caller's user-dir back as it found it.
   *
   * False for a throwaway user-dir (there is nothing to restore) and when
   * `keepStaged` was asked for.
   */
  restores: boolean;
  logsDir: string;
  cleanup(): void;
}

export interface StageOptions {
  /** Explicit location. When omitted a temp dir is made and later removed. */
  userDir?: string;
  /** Extra plugin/module trees to copy in, e.g. a dependency built elsewhere. */
  extra?: DiscoveredApp[];
  /**
   * Clear plugins/, modules/, module_data/ and logs/ from a caller-supplied
   * --user-dir before staging.
   *
   * Off by default, and deliberately so: this used to be unconditional, which
   * meant `--user-dir ~/.local/share/Logos/LogosBasecampDev` recursively
   * deleted the developer's real install — every other plugin, and every
   * module's data — while the header said "staging into a throwaway user-dir".
   * A temp dir is empty by construction, so the clear never did anything
   * except where it did damage.
   */
  reset?: boolean;
  /** Platform variant to unpack from a .lgx. Defaults to this host's. */
  variant?: string;
  /**
   * Leave the staged build in a caller-supplied `--user-dir` when the run ends.
   *
   * Off by default: a run puts the user-dir back the way it found it, because
   * `--user-dir <my real install>` means "test against my Basecamp", not
   * "replace the app in my Basecamp". Turn it on when installing the build IS
   * the point.
   */
  keepStaged?: boolean;
}

/**
 * e.g. "linux-amd64-dev" — matches the `variant` file Basecamp writes.
 *
 * The platform is a parameter so both branches can be tested from either host.
 * Read straight off `process.platform`, the macOS branch was executed by
 * nothing: CI is ubuntu-only, and the one test that covered it asserted the
 * Linux list when it was not running on a Mac — so it passed with the darwin
 * code deleted, while an archived task recorded it as regression-tested.
 */
export function hostVariant(platform: string = process.platform, arch: string = process.arch): string {
  const osPart = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";
  const archPart = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : arch;
  return `${osPart}-${archPart}-dev`;
}

export function stageUserDir(apps: DiscoveredApp[], opts: StageOptions = {}): StagedUserDir {
  const ephemeral = !opts.userDir;
  const root = opts.userDir
    ? path.resolve(opts.userDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), "sitometres-"));
  // Only a dir we made is ours to remove if the run is interrupted.
  if (ephemeral) reapDirOnExit(root);

  if (opts.reset && !ephemeral && fs.existsSync(root)) {
    for (const sub of ["plugins", "modules", "module_data", "logs"]) {
      fs.rmSync(path.join(root, sub), { recursive: true, force: true });
    }
  }
  for (const sub of ["plugins", "modules", "module_data", "logs"]) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }

  const wanted = new Set([...apps, ...(opts.extra ?? [])].map((a) => a.manifest.name));
  const foreign = ephemeral ? [] : existingApps(root).filter((n) => !wanted.has(n));

  const staged: string[] = [];
  const replaced: string[] = [];
  const inPlace: string[] = [];

  // Putting a caller's user-dir back the way it was found. `--user-dir <my real
  // install>` means "test against my Basecamp", not "replace the app in my
  // Basecamp" — and until this, the run replaced the installed copy of the app
  // under test and every dependency, permanently, with no way back.
  //
  // A throwaway user-dir has nothing to restore (the whole directory goes), and
  // --reset-user-dir is documented as destructive, so neither takes part.
  const restoring = !ephemeral && !opts.keepStaged && !opts.reset;
  const holdingPen = path.join(root, `.sitometres-restore-${process.pid}`);
  const undo: Array<{ dest: string; backup: string | null }> = [];
  for (const app of [...apps, ...(opts.extra ?? [])]) {
    const dest = path.join(root, app.slot, app.manifest.name);
    const src = path.resolve(app.artifact);
    const target = path.resolve(dest);

    // The destination can BE the source. `installedApps()` discovers apps by
    // scanning the Basecamp user-dir, setting `artifact` to the installed
    // directory — so `sitometres <app> --user-dir <that install>` resolved the
    // app to the exact path staging was about to remove. It removed it, and
    // then the copy failed with ERR_FS_CP_EINVAL: the run destroyed an
    // installed plugin and reported an error about copying a directory into
    // itself. It is already staged where Basecamp will look for it; leave it.
    if (src === target) {
      inPlace.push(app.manifest.name);
      staged.push(app.manifest.name);
      continue;
    }
    // The same accident one level down: an app built inside the user-dir it is
    // being staged into. Deleting the destination would delete the source, and
    // unlike the case above there is nothing sensible left to copy.
    if (src.startsWith(target + path.sep)) {
      throw new Error(
        `refusing to stage "${app.manifest.name}": it was found at ${src}, inside the directory ` +
          `staging would delete first (${target}). Point --user-dir somewhere else, or --app-dir at a built copy.`,
      );
    }
    if (!ephemeral && fs.existsSync(target)) {
      replaced.push(app.manifest.name);
      if (restoring) {
        // MOVED aside, not copied: a rename is atomic, costs nothing for a
        // plugin of any size, and — because the holding pen lives inside the
        // user-dir — it cannot fail with EXDEV the way a move to /tmp can.
        const keep = path.join(holdingPen, app.slot, app.manifest.name);
        fs.mkdirSync(path.dirname(keep), { recursive: true });
        fs.renameSync(target, keep);
        undo.push({ dest: target, backup: keep });
      }
    } else if (restoring) {
      // Nothing was here, so putting it back means taking it away again.
      undo.push({ dest: target, backup: null });
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    if (app.form === "lgx") {
      unpackLgx(app.artifact, dest, opts.variant ?? hostVariant());
    } else {
      copyTree(app.artifact, dest);
    }
    staged.push(app.manifest.name);
  }

  /** Swap every staged app back for whatever was there before it. */
  const putBack = (): void => {
    for (const { dest, backup } of undo.splice(0)) {
      try {
        fs.rmSync(dest, { recursive: true, force: true });
        if (backup && fs.existsSync(backup)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(backup, dest);
        }
      } catch {
        /* one app that cannot be put back must not strand the others */
      }
    }
    fs.rmSync(holdingPen, { recursive: true, force: true });
  };
  // Armed for the whole run: a Ctrl-C between staging and cleanup would
  // otherwise leave the developer without a plugin they had installed.
  const disarm = undo.length > 0 ? restoreOnExit(putBack) : () => {};

  return {
    root,
    staged,
    ephemeral,
    foreign,
    replaced,
    inPlace,
    restores: undo.length > 0,
    logsDir: path.join(root, "logs"),
    cleanup() {
      disarm();
      putBack();
      if (!ephemeral) return;
      releaseDir(root);
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not worth failing a test run over */
      }
    },
  };
}

/** Plugin and module names already installed in a user-dir. */
function existingApps(root: string): string[] {
  const out: string[] = [];
  for (const slot of ["plugins", "modules"]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, slot), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) if (e.isDirectory()) out.push(e.name);
  }
  return [...new Set(out)];
}

/**
 * Unpack a .lgx into an installed-plugin layout.
 * Falls back to any single available variant when the host's is absent, so a
 * cross-built package still runs rather than failing opaquely.
 */
export function unpackLgx(file: string, destDir: string, variant: string): void {
  const dest = path.resolve(destDir);
  const entries = readTarGz(file);
  if (entries.length === 0) throw new Error(`${file} is not a readable .lgx archive`);

  const available = new Set<string>();
  for (const e of entries) {
    const m = /^(?:\.\/)?variants\/([^/]+)\//.exec(e.name);
    if (m) available.add(m[1]!);
  }
  let chosen = variant;
  if (!available.has(chosen)) {
    const only = [...available];
    if (only.length === 0) {
      chosen = "";
    } else if (only.length === 1) {
      chosen = only[0]!;
    } else {
      throw new Error(
        `${path.basename(file)} has no "${variant}" variant. Available: ${only.join(", ")}. ` +
          `Pass --variant to choose one.`,
      );
    }
  }

  const prefix = chosen ? `variants/${chosen}/` : null;
  for (const e of entries) {
    const name = e.name.replace(/^\.\//, "");
    let rel: string | null = null;
    if (name === "manifest.json") rel = "manifest.json";
    else if (prefix && name.startsWith(prefix)) rel = name.slice(prefix.length);
    if (!rel || rel.length === 0) continue;
    // Tar entry names come from the archive, so "../../escape" is expressible.
    // Anything resolving outside the destination is dropped rather than written.
    const target = path.resolve(dest, rel);
    if (target !== dest && !target.startsWith(dest + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data);
    // Shared objects and helper binaries must stay executable.
    if (/\.(so|dylib)(\.\d+)*$/.test(rel)) fs.chmodSync(target, 0o755);
  }
  if (chosen) fs.writeFileSync(path.join(dest, "variant"), chosen + "\n");
}

function copyTree(src: string, dest: string): void {
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: true,
    // Nix store outputs arrive read-only; a later run must be able to replace them.
    force: true,
    filter: (from) => !/(^|\/)(\.git|node_modules|build|CMakeFiles)$/.test(from),
  });
  // Restore write permission so cleanup and re-staging work.
  for (const entry of fs.readdirSync(dest, { recursive: true, withFileTypes: true }) as fs.Dirent[]) {
    const p = path.join((entry as unknown as { parentPath?: string; path?: string }).parentPath ?? dest, entry.name);
    try {
      const st = fs.statSync(p);
      fs.chmodSync(p, st.mode | 0o200);
    } catch {
      /* best effort */
    }
  }
}
