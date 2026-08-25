---
name: sitometres
description: >
  Test a Logos Basecamp app's UI end to end - drive real clicks and prove from
  the app's own behaviour which backend calls fired and whether they worked.
  Use when asked to test, smoke-test, verify, or debug a Basecamp module or
  plugin (ui_qml or core), when a UI change needs checking against the real
  app rather than unit tests, or when an app "does nothing" and you need to
  find out why. Also use to write a setup profile that gets an app past a
  login or onboarding gate so the rest of its UI becomes testable.
---

# sitometres

Drives real mouse clicks through Basecamp's QML inspector and grades what each
one achieved. Read this before running it; the failure modes are specific and
several of them look like app bugs when they are not.

## Run it

```bash
sitometres <app>          # crawl an app, from any directory
sitometres                # the app in the current directory
```

Needs Node 20+ and a Basecamp built **with the QML inspector**. The inspector is
a compile-time feature and is OFF in release builds, so build one:
`cd logos-basecamp && nix build .#default` (or `.#bin-bundle-dir-inspector`).
It is found automatically in the usual places; `--basecamp <path>` or
`$SITOMETRES_BASECAMP` points at it otherwise. If it is missing the run dies
before it starts — `doctor --deep` says so in one line.

Given that, nothing else is required. It finds the app by name (working
directory, then the local Basecamp install), stages it and its dependencies into
a throwaway Basecamp, gives it a throwaway `$HOME`, drives it, and writes a
report to `.sitometres/<app>.json`.

A crawl clicks **12 controls by default** (`--limit`) and watches each for 2.5s
(`--settle`). An app with more controls is sampled, not swept.

If the app polls, pass `--ignore-calls module.method` (it also accepts `method`
or `module.*`), or the crawl grades inert controls `ran`: a background call
landing inside a click's window is indistinguishable from one the click caused.
A crawl where nearly every row says `ran` and names the same call is the
symptom. A spec's `ignore_calls:` does the same job, but only if a spec or
profile for this app already exists — a bare crawl of a new app has no ignore
list at all.

Other commands: `inspect <app>` (list controls as pasteable selectors),
`init <app>` (generate a spec from the real controls), `run <spec>`,
`doctor --deep` (check the machine and what its logs will show).

## Reading the result

| verdict | what it proves |
|---|---|
| `worked` | the app reported success **as prose**. A control's own label does not count, nor does text in a hand-rolled card, where the two cannot be told apart |
| `ran` | a backend call was dispatched and nothing complained |
| `FAILED` | the app threw, rendered an error, or a call failed that is attributable to this control |
| `unclear` | the screen changed and nothing said whether it worked — **or** a call failed nearby that could not be pinned on this control. Check the run's separate failure list — and the `not reached` / `left unclicked` coverage lines under the table — before reporting a run as clean |
| `no change seen` | no call logged, no new text. Reads the same for a dead handler and for a popup, a value-only update, or a screen that reuses its labels — do not report it as an unwired control without checking |

**Checking a `no change seen`, in order.** Only after these does "the handler is
not wired" become the answer.

1. `--headed` — run with the window shown instead of offscreen, and watch the
   click land.
2. `--settle <ms>` — the crawl watches 2.5s. A handler slower than that finishes
   after nobody is looking.
3. `sitometres inspect <app> --hidden` — a `Popup`, a cached page or a screen the
   user left is present but invisible.
4. `sitometres doctor --deep` — rules out a build whose Qt logging never reaches
   the run. A session that cannot read logs grades `unclear`, not `no change
   seen`, so a table full of `unclear` means "sitometres cannot see", not "your
   app is broken", and `state:` is the only oracle still working.

**`ran` is not success, and you must not report it as one.**
`LogosQmlBridge::callModule` returns a module's answer to QML and logs nothing,
so `{"ok":true}` and `{"error":"insufficient funds"}` are indistinguishable from
the log. A crawl proves a call was *made* and catches failures the app
*surfaces*. It cannot prove a transfer settled. Say "the call fired" — not "it
worked" — unless the verdict is `worked`.

`INCONCLUSIVE` in a spec run means the evidence could not be read at all
(usually `--attach`, where the env var that routes Qt logging to stderr cannot
be set on someone else's process). It is not a pass and not a failure.

**Only the log keys written out become INCONCLUSIVE.** `no_errors:` and
`calls_succeed:` are on by default and are *skipped silently* in a session that
cannot read logs, so a step asserting `text:` or `state:` can report PASS there
while the app threw and a call timed out. Write them explicitly when a run like
that has to check them.

`--strict` is the CI gate, and nothing else is: without it a run that proved
nothing exits 0. It fails a `run` whose verdict is INCONCLUSIVE, and a crawl
where no control did anything observable or where the logs could not be read. It
does not fail on `unclear`, which is normal. Everything it counts also appears
in `--junit`/`--json`.

## Writing a spec

Three assertion families. Reach for them in this order:

```yaml
app: YOUR_APP_NAME
with: [YOUR_MODULE]                            # dependencies to stage alongside it
ignore_calls: ["YOUR_MODULE.pendingRequests"]  # a poll would swamp every step

steps:
  - name: the app opens                        # `state:` needs the app open; open it first
    open: YOUR_APP_NAME

  - name: connecting asks the wallet to approve
    click: "Connect"
    expect:
      state: "root.phase === 'connecting'"       # strongest: works on any build
      text: [{ text: "approve the connection", match: contains }]
      calls: ["YOUR_MODULE.connectRequest"]      # proves it reached the backend
```

`YOUR_APP_NAME` is the app you are testing; `YOUR_MODULE` is a backend module it
calls. Nothing here is specific to any particular app.

- `state:` — a QML expression in the app's own root. The only family that works
  on every build, because it needs no log evidence. Put load-bearing checks
  here. It does need the app open: the root is found from the `view` the
  manifest declares, and a check that cannot find one reports INCONCLUSIVE
  saying so rather than passing.
- `text:` / `not_text:` — what the user sees. Typographic characters are
  normalised, so plain `"..."` matches `…`.
- `calls:` / `no_calls:` / `events:` / `console:` — read from the log. The
  first three take lists, never bare strings. Both synchronous and
  `logos.callModuleAsync` dispatches are seen. `calls_succeed:` catches hangs
  and timeouts inside the step's window, **not** a module returning an error.
  `no_errors:` is on by default; `no_warnings:` is opt-in and catches missing
  assets and binding loops.

### What a step can do

One gesture per step, then the checks. Every key below is supported; only
`click:` and `expect:` were previously written down, which is how specs end up
weaker than the tool allows.

| key | what it does |
| --- | --- |
| `open: "App Name"` | open the app from Basecamp's sidebar. First step of most specs. |
| `click: <selector>` | click a control. |
| `type: { into: <selector>, text: "…" }` | type into a field. Also `secret: true`, `clear: false` (append instead of replace), `then: enter\|tab\|none`. |
| `set: { target: <selector>, property: "…", value: … }` | set a QML property directly, for state a gesture cannot reach. E.g. `set: { target: { objectName: "amountField" }, property: "text", value: "5" }`. |
| `eval: "<qml expression>"` | evaluate an expression in the app's root. |
| `sleep: 3s` | wait a fixed time. A last resort — prefer `waitFor:`. |
| `waitFor: { … }` | poll the SAME shapes as `expect:` until they come true, bounded by `timeout:`. This is how you wait for a fetch instead of sleeping. |
| `screenshot: "name"` | capture a PNG into the run's artifacts. |
| `timeout: 20s` | override the spec-level timeout for this step. |
| `comment: "# breakpoint: …"` | pause here in `--debug`. |

`type:` unlocks anything driven by text — a search box, a URL field, a filter.
Without it a spec can only click what is already on screen, and whole features
read as untestable when they are not.

### Give the spec something stable to assert on

`text:` is the weakest oracle and the one people reach for first. Two traps:

- **It proves a label is on screen, not which screen you are on.** A label
  almost always appears more than once — on the control, on a nested `Text`
  inside it, and in unrelated prose — and `text:` passes on any one of them, so
  an assertion meant for a button can be satisfied by a subtitle, and two
  screens that share a label are indistinguishable. "Is the detail page
  showing?" cannot be answered by asking whether its labels exist. (Hidden
  controls are excluded by default; `{ text: "…", include_hidden: true }` is the
  opt-in for matching one the user cannot see.)
- **Values change every run.** Hashes, ids, balances and timestamps cannot be
  written into a spec.

So expose the state you want to assert as a plain property on the app's root
and assert it with `state:`:

```qml
// in the app
readonly property string navType: nav.type          // "home" | "detail" | …
readonly property string pageError: ""              // set when a page fails to load
```

```yaml
- name: a row opens the detail page
  click: { type: "TxRow", nth: 0 }
  expect:
    state: "root.navType === 'detail' && root.pageError === ''"
```

That is stable across runs, unambiguous about which screen is live, and it costs
the app three lines. A `pageError`-style property is worth adding on its own
merits: a QML page that fails to compile renders as an empty rectangle, and
without a property saying so, nothing — not the app, not this tool — reports it.

Selectors: a bare string is the visible label. `{ objectName: "sendButton" }` is
the only stable handle — if the app has none, say so and suggest adding them.
`{ type: "TextField", nth: 0 }` is the positional fallback.

`type:` echoes what it typed into the terminal, the JSON report and the JUnit
file. Add `secret: true` for anything that should not appear there; a field
whose `echoMode` hides its input is masked automatically. `SITOMETRES_*` is
stripped from the environment the app under test receives.

A **file dialog** cannot be driven. The inspector supports it and nothing in
sitometres calls that, so a flow with a file picker stops there — and a crawl
that opens one keeps clicking into a modal that swallows everything, which
grades as a run of inert controls. Say so rather than reporting the inert run.

## Writing a setup profile — the high-value task

Most apps hide almost everything behind a gate. A wallet app that opens on
"Create your wallet" offers a crawl four controls, and nothing else in the app
is reachable. A **setup profile** walks through the gate, and the crawl then
explores what is behind it — the difference between four controls and the whole
application.

A profile is an ordinary spec, run before the crawl. Put it at whichever of
these fits, in the app's own repo:

```
.sitometres/<app>.setup.yaml
.sitometres/setup.yaml
<app>.setup.yaml
sitometres.setup.yaml
```

or contribute one to `profiles/<app>.yaml` in sitometres itself so it ships for
everybody. It is picked up automatically; `--no-setup` skips it, `--setup <file>`
overrides it.

How to write one for an app you do not know:

1. `sitometres inspect <app>` — see the controls and their real labels.
2. `mkdir -p .sitometres && sitometres init <app> --out .sitometres/<app>.setup.yaml`
   — a spec skeleton with those labels filled in, written where setup discovery
   looks. Without `--out` it lands in `sitometres.yaml`, which is a test spec:
   discovery never reads it. `init` does not create the directory for you.
3. Write the shortest path through the gate. Assert at each step, so a profile
   that stops working fails loudly instead of leaving the crawl on the wrong
   screen.
4. Re-run `sitometres <app>` and confirm the crawl now reaches further. The run
   prints a `setup` line either way: `setup <file>` means your profile ran,
   `setup none found for <app>` means the file is not where discovery looks and
   everything below it is a crawl of your gate.

`profiles/` ships worked examples. Read one before writing your own — and note
where it *ends*, because that is the lesson. A wallet profile waits for
onboarding, types a password into two positionally-addressed fields, creates the
wallet, asserts the create call fired **and** that the recovery-phrase screen is
on screen, acknowledges the phrase — and then keeps going, because creating a
wallet does not open it: the app encrypts the store and asks for the password
again, so the profile waits for "Unlock", retypes, clicks through, and only then
asserts the gate is behind it.

**A gate is not passed until you assert something only the screen behind it
renders.** "Screen X is gone" is also satisfied by screen Y — and Y may be a
second gate. That profile used to stop at "the backup screen is gone", reported
every step green, and left the crawl exploring the unlock dialog of a wallet
that was still locked.

Keep profiles safe to run: they execute against a throwaway `$HOME`, so a
password can be a literal. Never write a real credential into one.

## Debug Mode

When debugging a failing test or investigating unexpected behavior, use the `--debug` flag to enable interactive debugging:

```bash
sitometres run spec.yaml --debug
```

This pauses execution at step boundaries and on failures, allowing inspection of:
- QML state with the `state` command
- Log evidence with the `logs` command  
- UI snapshots with the `ui` command

`--debug` alone pauses at every step boundary. To stop only where you care, name
the steps — either with `--breakpoint <n>` (which requires `--debug`; it is an
error without it) or by marking them in the spec:

```yaml
steps:
  - name: critical step
    comment: "# breakpoint: verify this step"
    click: "Submit"
    expect:
      calls: ["module.method"]
```

As soon as any step carries a breakpoint comment, those steps are the only ones
that pause. `q` at a pause ends the run and still writes the summary and any
`--json`/`--junit` for the steps already graded; the steps it never reached are
reported as inconclusive rather than dropped.

Debug mode preserves all sandbox isolation - throwaway HOME and user-dir remain in effect, and cleanup runs normally on quit. Use it to understand the application state at the moment of failure rather than guessing at the cause.


## Things that will mislead you

- **A staged source checkout looks like a broken app.** If a repo declares
  `view: qml/Main.qml` and does not contain it, that is a source tree and the
  build output lives in `result/`. sitometres rejects those now and says so —
  if you see "not built", build it rather than debugging the app.
- **`smoke` clicks things.** It skips labels that look destructive or
  value-moving (`send`, `transfer`, `approve`, `export`, `delete`), but that is
  a heuristic over visible text. Point it at a testnet; use `--skip` for the
  rest.
- **`--real-home`** makes the app see your actual wallet and settings instead of
  a sandbox. Do not pass it casually. It is the *only* flag that does this —
  `--wallet-password` unlocks whichever wallet the run already has. Prefer
  `SITOMETRES_WALLET_PASSWORD` — a flag is visible to `ps`. Neither reaches the
  app under test; `SITOMETRES_*` is stripped from its environment.
- **The sandbox isolates data, not executables.** `~/.local/bin` and friends are
  symlinked through to the real ones so apps can shell out; an app that writes
  there during a run writes to the real directory.
- **`--user-dir <a real install>` borrows it, and gives it back.** Staging moves
  the installed copy of the app under test — and of anything staged with it —
  aside for the run, then swaps it back at the end; anything the run added is
  removed again. Everything else in that user-dir is untouched throughout. The
  header names what was moved. `--keep-staged` leaves the build installed
  instead. If the copy being tested IS the installed one, nothing is moved at
  all.
- **A failure line names neither module nor method.** sitometres recovers the
  method from the transport line before it, and says so when calls overlapped.
  Treat a hedged attribution as a hint, not a fact.
- **A timed-out call surfaces after its click.** The transport waits 20s; the
  crawl watches 2.5s. These are reconciled at the end, listed separately from
  the per-click grades, and they DO fail the run. A crawl whose table is all
  green can still exit 1 for this reason — read the list.
- **Repeated table rows are folded.** A list of 265 hashes is one control with
  different data; the report says how many were skipped.
- **A crawl reports its own coverage, and none of it fails the run.** Three
  lines can sit under the table: `N repeated list row(s) skipped`, `N not
  reached` (navigation moved on and neither going back nor re-opening brought
  the control back), and `N control(s) left unclicked — raise --limit`. None
  count as problems and none affect the exit code. An all-green table with
  those lines under it means "the controls that were clicked look fine" — say
  that, not "the app is fine".
- **The inspector is unauthenticated and listens on every interface** while a
  run is in progress. Do not run tests on an untrusted network.

## When it cannot open the app

First rule out the two that are not your app at all: **no Basecamp with the QML
inspector** (see "Run it" — release builds do not have it) and **no app found**,
which means the name did not resolve in the working directory or the Basecamp
install. `doctor --deep` names both in one line. Only then is it the app.

The report tells you which half you are in. "The plugin IS staged at … so this
is Basecamp not listing it" means the files are there and Basecamp declined
them — read the log above. An empty plugin directory means staging failed.
