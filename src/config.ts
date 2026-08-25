// ---------------------------------------------------------------------------
// Remembered settings.
//
// One thing genuinely varies per machine and cannot be derived: where the
// developer keeps an inspector-enabled Basecamp. Asking once and remembering
// beats a hardcoded list of somebody else's directory layout.
//
// Kept deliberately tiny — a test runner that grows a configuration language
// is a test runner nobody can reason about.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  /** Path to a Basecamp binary with the QML inspector compiled in. */
  basecamp?: string;
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "sitometres", "config.json");
}

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return {};
    const o = raw as Record<string, unknown>;
    const out: Config = {};
    if (typeof o.basecamp === "string") out.basecamp = o.basecamp;
    return out;
  } catch {
    return {};
  }
}

export function saveConfig(patch: Config): string {
  const file = configPath();
  const merged = { ...loadConfig(), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  return file;
}
