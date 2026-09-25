# Changelog

What changed between releases, and why it mattered. Entries say what was wrong
rather than which files moved, on the principle the rest of this project runs
on: a change nobody can act on is not worth recording.

The format is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project uses [semantic versioning](https://semver.org/spec/v2.0.0.html). Dates
are the day the version reached npm.

## [Unreleased]

## [0.2.0] - 2026-09-25

### Added

- **Basecamp 0.3.0 support**, alongside 0.2.x.
  - Both versions' wording for a failed or timed-out module call is recognised, as are 0.3.0's
    messages for an unreachable module, a call held until its module appears, and a deferred call
    that timed out.
  - 0.3.0 hides module-host and view-module (ui-host) debug output by default. sitometres turns
    those channels on when it launches Basecamp; an explicit `LOGOS_LOG_LEVEL`, `SPDLOG_LEVEL` or
    `QT_LOGGING_RULES` of yours still wins.
  - Each log channel is reported in the run. A check that depends on a channel that never appeared
    is INCONCLUSIVE rather than PASS.
  - The token handshake Basecamp performs on first contact is not counted among the app's calls.
- **Timeouts you can set for anything.** Every time budget is settable and none has a ceiling.
  - Spec header: `command_timeout:`, `call_timeout:`, `open_timeout:`, `startup_timeout:`,
    `settle:` and `open_settle:`, beside `timeout:`.
  - Step: `command_timeout:` and `settle:`, beside `timeout:`.
  - Flags: `--step-timeout`, `--command-timeout`, `--call-timeout` and `--open-timeout` on every
    command that opens an app, and `--settle` on `run`. `doctor --deep` also takes `--timeout`,
    `--command-timeout` and `--call-timeout`.
  - The most specific setting wins: step, then spec header, then flag, then default. Startup is
    the exception, where `--timeout` wins.
  - Durations accept `ms`, `s`, `m`, `h`, and `none` (or `unlimited`) for no deadline. Negative
    values are refused. Very long values are honoured exactly. `sleep:`, `open_settle:` and a
    crawl's `--settle` must end, so they refuse `none`.
  - See the new Timeouts section in the README.
- **Defaults follow the module bridge's reply window.** It is read from the log, or declared with
  `call_timeout:` / `--call-timeout`. A Basecamp built with a longer window gets longer defaults
  automatically.
- **Cross-app specs.**
  - `open:` accepts any UI app the run staged (the spec's own or one in `with:`), by module name
    or display label.
  - `state:`, `wait_for: state:` and `eval:` accept `{ expr, in: <app> }` to evaluate in another
    opened app.
  - Setup profiles, the wallet unlock and error attribution follow the app they belong to.
  - See `examples/tip_jar_connect.yaml`.
- **The run header lists every staged artifact with a hash.** `--json` carries the same records in
  `staged[]`, and `--junit` as suite properties, together with the build each run graded
  (`source`).
- `sitometres doctor` shows what a run would stage, and `doctor --deep` checks that the run staged
  exactly that.
- `expect: file:` asserts that the app left a file on disk, optionally containing given text. It
  needs neither the log nor the QML tree.
- `comment:` on a step is shown in the terminal report and recorded in `--json`.
- A false compound `state:` names the clauses that were false and what their left side held.
- `planStaging`, `compareCopies`, `knownBuildTime` and the `StagedRecord` and `StagingPlan` types
  are exported for library use.

### Changed

- **Per-command deadline.** Each inspector command now waits as long as its step's `timeout:`
  allows, and never less than the bridge's reply window plus 10 s (30 s on stock Basecamp), where
  it used to be a fixed 20 s. A synchronous module call can now time out and be reported as such,
  instead of looking like a hung app.
  - A long step timeout also means a truly hung handler is noticed later. Set a short
    `command_timeout:` when you want fast hang detection.
- **Quieter off a terminal.** Progress is narrated once per phase instead of once per step, which
  makes a run's output roughly 40% smaller for CI and automated readers. `SITOMETRES_PROGRESS=all`
  restores per-step narration.
- **Local builds win.** A local build is preferred over an installed copy of the same version,
  whatever their file times. A higher version still wins wherever it is found. Build times that
  cannot be known, as in a nix store, are reported as unknown rather than as 1970. Every copy that
  was passed over is listed with the reason.
- `init` no longer writes a fixed `timeout: 30s` into the spec it generates.
- The run header's `built` line is replaced by one `staged` line per app.

### Fixed

- A step's `timeout:` now bounds its action (`click:`, `type:`, `set:`, `eval:`, `screenshot:`),
  not only `wait_for:` and expectations. An `open:` step's own `timeout:` is honoured.
- Step `timeout:` and `sleep:` values are validated when the spec loads, not after Basecamp has
  started.
- Duration flags such as `--timeout 30s` are parsed. Previously anything but plain milliseconds
  was silently ignored. An unreadable value is now refused.
- Negative expectations (`no_calls:`, `no_errors:`, `not_text:`, `calls_succeed:`) are always
  watched for their full settle time, even when the action used up the step's budget.
- Startup no longer waits for a "Logos Core started" line that some builds never print. A
  Basecamp that exits during startup is reported at once.
- Setup profiles run inside the app just opened, and only a passing step counts, so a profile can
  no longer appear to pass a gate it never reached. Profiles no longer act in another app's window
  when two are open.
- Clicking by `objectName` clicks that control, not a neighbouring one.
- A manifest field with the wrong type (for example `"version": 2` or `"main": null`) no longer
  aborts a run.
- A failure writing one machine artifact (`--json` or `--junit`) no longer destroys the other or
  misreports the run.
- A spec with no steps is refused instead of passing.
- `stop()` releases Basecamp's output pipes on every path, so a program embedding sitometres can
  exit.
- `examples/medusa_wallet.yaml` documents `--no-setup`, which it needs because its bundled setup
  profile already creates and unlocks the wallet.

## [0.1.2] - 2026-09-05

### Fixed

- `hasInspector()` refused nix bundles that do have the QML inspector compiled
  in. It probed the wrapper's companion binary as `.<name>`, but
  `nix build .#bin-bundle-dir-inspector` — the build both README.md and SKILL.md
  tell you to make — ships it as `.<name>.elf`, and that bundle carries no
  extensionless name at all. `doctor` then told you to build the thing you had
  already built. The probe now also covers `.<name>.elf` and the nixpkgs
  `makeWrapper` spelling `.<name>-wrapped`, and resolves the binary before
  looking beside it, so a symlink to the binary no longer sends it hunting in
  the link's own directory. Probing stays anchored to names derived from the
  binary asked about: globbing `bin/.*.elf` would let a sibling component's
  inspector answer for a Basecamp that has none.

  Reported and fixed by [@fryorcraken](https://github.com/fryorcraken) in
  [#3](https://github.com/paradoxcomputer/sitometres/pull/3), closing
  [#1](https://github.com/paradoxcomputer/sitometres/issues/1).

## [0.1.0] - 2026-08-25

First release. A UI test runner for Logos Basecamp apps: it drives real clicks
through the QML inspector and proves from the app's own logs that the expected
backend calls fired and succeeded.

---

There is no 0.1.1. The version was skipped, not withdrawn — nothing was ever
published under it.

[Unreleased]: https://github.com/paradoxcomputer/sitometres/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/paradoxcomputer/sitometres/releases/tag/v0.2.0
[0.1.2]: https://github.com/paradoxcomputer/sitometres/releases/tag/v0.1.2
[0.1.0]: https://www.npmjs.com/package/@paradoxcomputer/sitometres/v/0.1.0
