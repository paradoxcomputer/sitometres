# Captured Basecamp log lines

Verbatim lines from real Logos Basecamp runs, captured on 2026-09-24 against
the 0.2.2 and 0.3.0 dev builds (the inspector-enabled `nix build .#default`).
The classifier tests feed these through `expandLine` and `parseLine` exactly as
a live run would, so a pattern that drifts from what Basecamp really prints
fails here rather than in the field.

- `*.v022.log` / `*.v030.log`: one scenario each, cut from a capture. The name
  says what happened (a sync call that timed out, a replica never acquired, the
  0.3.0 token handshake, a held async call, ...).
- `session-*.log`: whole sessions, with the capture harness's own markers
  removed. `passive` launched Basecamp and did nothing; `probes` drove a probe
  app through failing and succeeding calls; `debugenv` is the 0.3.0 probes run
  with `LOGOS_LOG_LEVEL=debug` and `QT_LOGGING_RULES=logos.viewhost.debug=true`,
  the two switches sitometres now sets.

Scrubbed before committing: user-dir paths became `/tmp/sito-userdir`, and the
throwaway capability tokens became `00000000-0000-4000-8000-000000000000`.
Nothing else was edited.
