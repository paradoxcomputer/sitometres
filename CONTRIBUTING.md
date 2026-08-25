# Contributing to sitometres

## The invariants

These are not style preferences. Most of the bugs this project has had were
violations of one of them, and they are not obvious from reading the code.

**A verdict claims exactly what it proved, and no more.** `worked` means the app
itself reported success. `ran` means a call was dispatched and nothing
complained — it is *not* success, and must never be reported as such:
`LogosQmlBridge::callModule` hands a module's answer back to QML and logs
nothing, so `{"ok":true}` and `{"error":"insufficient funds"}` are
indistinguishable from the log. If you find yourself widening what a verdict
implies, you are removing the reason anyone would trust the tool.

**INCONCLUSIVE is a real verdict, and a green run must never stand in for one.**
Evidence that cannot be read is not evidence of success. A check the spec ASKED
for and that could not run reports INCONCLUSIVE with the remedy; it does not
quietly disappear, and it does not pass. Test both directions when you touch the
assertion engine — the worst failure mode here is a PASS that checked nothing,
because a green run is the product.

The one deliberate exception is the pair that is on by default, `no_errors:` and
`calls_succeed:`: on a session that cannot read logs they are skipped rather
than reported, so a quiet build does not litter every step with a verdict nobody
asked for. That is a real hole and the docs now name it — a step that also
asserts `text:` or `state:` reports PASS there while the app may have thrown. If
you narrow it, narrow it in the report, not by inventing a verdict.

**A click is POSTED, not sent.** When the inspector returns, no handler has run.
Anything that can only be falsified by something happening — `no_calls:`,
`not_text:`, `no_errors:` — is trivially true at t=0, so it must be given time
before a clean result is accepted. See `Runner.pollChecks`.

**A run must not touch the developer's real data.** A throwaway Basecamp
user-dir and a throwaway `$HOME`, and `--real-home` is the only thing that
widens it. Note what the sandbox does *not* give you: tool directories are
symlinked through to the real ones so apps can shell out, which means an app
that writes into `~/.local/bin` writes into the real one. Say so; don't imply
otherwise.

**Nothing may hardcode one app.** This is a tool for anyone building a Basecamp
module. If you need app-specific knowledge, it belongs in `profiles/<app>.yaml`,
not in `src/`.

**Log patterns are measured, not imagined.** Every regex in `src/logs/classify.ts`
carries its match count against the real corpus in
`~/.local/share/Logos/LogosBasecampDev/logs`. If you add one, count it first and
put the number in the comment. The async-call bug existed because
`invoking remote method` was assumed to cover every dispatch; it covers 0 of 936
asynchronous ones.

## Tests

```bash
npm test          # build + the whole suite, about 25s
npm run lint      # typecheck only
npm run coverage  # the same suite, and fail if a function is executed by nothing
```

**Every function in `dist/` is executed by some test, and the gate keeps it that
way.** Not because the number matters — function coverage means "entered", not
"pinned" — but because a module nothing calls is a module nothing can regress
safely, and this project has been burned by exactly that: `assessFidelity`, the
sole producer of the flag deciding whether any log assertion returns a verdict
or INCONCLUSIVE, was reached by no test at all while three audits walked past it.
`scripts/coverage-gate.mjs` names the offending function; its `UNREACHED` list is
empty and adding to it is a deliberate act, not a way to move the number.

Most of the 25s is four files that run a real process: `tests/helpers/fake-basecamp.mjs`
is a Node script that speaks the inspector protocol and emits log lines in the
shapes `src/logs/classify.ts` measures. A test must not need a Basecamp; it may
have something on the other end of the socket, which is what makes `boot`,
`launch`, the readiness gate and every command body testable at all. The single
slowest test spends openApp's 15s click window on purpose — see the comment in
`tests/crawlnav.test.mjs`.

**A test must not need a Basecamp.** The suite runs anywhere, on fixtures and
fakes. The one test that does need a real binary is gated behind
`SITOMETRES_INTEGRATION=1` and is skipped by default. If you cannot test
something without launching an app, that is usually a sign the logic wants
extracting — `parseArgs` and `homeAndWallet` were both untestable until they
were moved out of a module that ran on import.

**A test that would pass with the code deleted is worse than no test.** Asserting
an object literal's own fields back is not a test. Neither is asserting shape
where the value is what matters.

When you fix a bug, add the test that would have caught it, and say so in the
test's own comment. Several files here open with the failure they exist to
prevent; keep that.

## Commits

Subject in the imperative, lowercase, describing the behaviour change rather
than the edit. The body explains what was wrong and why the fix is the right
one. Do not add Co-Authored-By trailers.

## Planning

Changes are tracked with [OpenSpec](https://openspec.dev): `openspec/` holds the
proposals, specs and task lists, and `openspec-dash` shows progress. The
directory is gitignored — it is a local planning aid, not part of the package.
