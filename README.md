# sitometres

UI tests for [Logos Basecamp](https://github.com/logos-co/logos-basecamp) apps.

`sitometres` drives real mouse clicks through Basecamp's QML inspector and then
checks what each click actually caused — which backend methods it invoked,
whether they succeeded, what the app's own state became, and what the user can
now see.

It is meant for anyone building a Basecamp module, not for one particular app:
point it at your repo and it finds your plugin, stages it into a throwaway
Basecamp instance, and drives it.

One command, no configuration, no spec file:

```console
$ sitometres YOUR_APP_NAME

  app       YOUR_APP_NAME (ui_qml) -> YOUR_MODULE
  built     plugins/YOUR_APP_NAME (v0.1.0, dir, 4 min ago)
  basecamp  ~/logos-basecamp/result/bin/LogosBasecamp
  user-dir  /tmp/sitometres-bkg0hc
  home      /tmp/sitometres-home-FLa4g8 (throwaway; tool dirs link through to the real ones)
  mode      headless (offscreen), logs from child stdout (live)
  inspector port 41293 (all interfaces, unauthenticated)

  setup   none found for YOUR_APP_NAME
        if it opens on a login or onboarding gate, write one at .sitometres/YOUR_APP_NAME.setup.yaml
  PASS  open YOUR_APP_NAME                       59 nodes, 1 call(s)

  clicking up to 12 control(s)

  RAN   click "Refresh" ran (unconfirmed)
        called YOUR_MODULE.listItems
        the call was made; whether it succeeded is not visible from the log
  OK    click "Connect" worked
        called YOUR_MODULE.connectRequest
        the app reported: Connected
  ????  click "Amount" unclear
  NONE  click "About" no change seen
        no backend call logged, and no new text appeared
        that also looks like this for a popup, a value-only update, or a screen that reuses the same labels

  Report — YOUR_APP_NAME v0.1.0
  ┌─────────┬────────────────┬───────────────────────────────────────────────────────┐
  │ Control │ Outcome        │ What happened                                         │
  ├─────────┼────────────────┼───────────────────────────────────────────────────────┤
  │ Refresh │ ran            │ YOUR_MODULE.listItems                                 │
  │ Connect │ worked         │ YOUR_MODULE.connectRequest, YOUR_MODULE.actionApprov… │
  │ Amount  │ unclear        │ now shows: Enter an amount                            │
  │ About   │ no change seen │                                                       │
  └─────────┴────────────────┴───────────────────────────────────────────────────────┘
  1 worked  1 ran  0 failed  1 unclear  1 no change seen

  "ran" means the call was dispatched, not that it succeeded — the module's
  answer goes back to QML, not to the log. To assert an outcome (a transfer
  settled, a token sent), name it in a spec: sitometres init YOUR_APP_NAME

  report written to .sitometres/YOUR_APP_NAME.json
```

Throughout this README, **`YOUR_APP_NAME`** is the Basecamp app you are testing
and **`YOUR_MODULE`** is a backend module it calls. Substitute your own; nothing
here is specific to any particular app.

## Install

```bash
npm install -g @paradoxcomputer/sitometres
```

Or from a checkout, if you want to hack on it:

```bash
git clone https://github.com/paradoxcomputer/sitometres
cd sitometres
npm install && npm run build && npm link
```

`npm link` puts `sitometres` on your PATH pointing at the build in your working
copy — so `npm run build` after an edit updates the installed command too. Undo
with `npm unlink -g @paradoxcomputer/sitometres`.

If the shell still says `command not found`, your npm prefix is not on PATH:

```bash
export PATH="$(npm config get prefix)/bin:$PATH"
```

Needs Node 20+ and a Basecamp binary **with the QML inspector compiled in**.
The inspector is a compile-time feature and is off in the shipping
AppImage/DMG, so build one:

```bash
cd logos-basecamp && nix build .#default      # or .#bin-bundle-dir-inspector
```

`sitometres` finds it automatically in the usual places; otherwise pass
`--basecamp <path>` or set `$SITOMETRES_BASECAMP`.

While a run is in progress a status line says what is happening right now —
staging, waiting for the inspector, which control is being clicked — and how
long it has been going. Off a TTY it degrades to one plain line per step, so CI
logs stay readable.

## Start here

```bash
sitometres                   # test the app in this directory
sitometres YOUR_APP_NAME     # test any app by name, from anywhere
```

That is the whole interface. The app is found by name in the current directory
or in your Basecamp install; its dependencies are staged automatically,
preferring a built copy over a manifest-only stub.

When you want more:

```bash
sitometres inspect YOUR_APP_NAME   # list the controls, as pasteable selectors
sitometres init YOUR_APP_NAME      # write a starter spec from the real controls
sitometres run spec.yaml           # run a spec
sitometres doctor --deep           # check the machine, and what the logs will show
```

## Hand it to an agent

sitometres is built to be driven by an AI coding agent as much as by you: it
takes one command, its output is graded rather than raw, and every verdict says
what it does *not* prove. `SKILL.md` in this repo is written for exactly that —
install it once and your agent knows how to test a Basecamp app without being
told.

```bash
npm run skill:install     # from a checkout
```

or by hand, which is all that script does:

```bash
mkdir -p ~/.claude/skills/sitometres && \
  ln -sfn "$(npm root -g)/@paradoxcomputer/sitometres/SKILL.md" \
          ~/.claude/skills/sitometres/SKILL.md
```

**Personal scope, not project scope.** A skill under a repo's own
`.claude/skills/` loads only while you are working *in that repo* — and
sitometres tests apps that live in other repos, so it would never load where you
need it.

Then just ask, in the app's repo:

```
> test this app with sitometres and tell me what's broken
> this app opens on a login screen — make the rest of it testable
> sitometres says nothing happens when I click Send. is my app broken?
```

The skill is what stops an agent reporting a green run as a working app. It
carries the things the output alone does not say: that `ran` means a call was
dispatched and *not* that it succeeded, that `no change seen` looks identical
for a dead handler and a popup, that a crawl clicks 12 controls by default and
says so under the table, and that a polling app makes every control look busy
unless you pass `--ignore-calls`. An agent without it will confidently tell you
an untested app is fine.

`AGENTS.md` is a symlink to the same file, for tools that look for that name.

## Debug Mode

Interactive debugging allows you to pause test execution and inspect the application state at any point.

```bash
sitometres run spec.yaml --debug       # pause at step boundaries and on failures
sitometres run spec.yaml --debug --breakpoint 3  # pause before step 3
```

When debug mode is active, you can use the following commands at the debug prompt:

- `help` or `h` - Show available commands
- `state` or `s` - Show current QML state
- `logs` or `l` - Show log evidence for current step
- `ui` or `u` - Show current UI snapshot
- `next` or `n` - Execute next step and pause
- `continue` or `c` - Continue execution without pausing
- `quit` or `q` - Quit the test run

Debug mode also automatically pauses on failures, allowing you to inspect the state before deciding whether to continue or quit. You can add breakpoints in your spec files using comments:

```yaml
steps:
  - name: verify login state
    comment: "# breakpoint: check state after login"
    click: "Login"
    expect:
      state: "root.phase === 'logged_in'"
```

Debug mode preserves all sandbox isolation - your real data remains protected, and cleanup runs normally on quit.

## What a crawl can and cannot tell you

`smoke` grades every click, and the grades mean something specific:

| | meaning |
|---|---|
| `worked` | the app itself reported success — a confirmation appeared **as prose**. Text that is a control's own name does not count, and neither does text in a hand-rolled card, where the two are indistinguishable |
| `ran` | a backend call was dispatched and nothing complained |
| `FAILED` | the app threw, rendered an error, or a call failed and could be attributed to *this* control. A failure the tool cannot pin on one control is reported separately and still fails the run |
| `unclear` | the screen changed but nothing said whether it worked |
| `no change seen` | no backend call logged and no new text appeared. NOT proof the control is dead: a popup, a value-only update, or navigation to a screen with the same labels all read like this |

**`ran` is not success.** `LogosQmlBridge::callModule` returns a module's answer
to QML and logs nothing, so `{"ok":true}` and `{"error":"insufficient funds"}`
are indistinguishable from the log. A crawl can prove a call was *made*, and can
catch a failure the app surfaces — it cannot prove a transfer settled.

For that, name the outcome in a spec:

```yaml
  - name: sending actually moves the token
    click: "Send"
    expect:
      calls: ["YOUR_MODULE.startSendTransfer"]
      state: "root.lastTxStatus === 'confirmed'"
      text: ["Sent"]
```

Every run ends with the table and writes the same data to
`.sitometres/<app>.json` (`--report <file>`, or `--no-report`):

```
  Report — YOUR_APP_NAME v0.2.0
  ┌────────────────┬────────────────┬────────────────────────────────────────┐
  │ Control        │ Outcome        │ What happened                          │
  ├────────────────┼────────────────┼────────────────────────────────────────┤
  │ Add a server   │ worked         │ the app confirmed: "Reads a server at… │
  │ SERVER ADDRESS │ FAILED         │ could not reach a server at http://…   │
  │ All            │ worked         │ the app confirmed: "✓ verified"        │
  │ Newest         │ no change seen │                                        │
  └────────────────┴────────────────┴────────────────────────────────────────┘
  2 worked  0 ran  1 failed  0 unclear  1 no change seen

  223 repeated list row(s) skipped — same control, different data.
```

Repeated table rows are folded away: a list of records is one control with
different data in it, and clicking 265 of them proves nothing that clicking two
does not.

## Writing a spec

```yaml
app: YOUR_APP_NAME
with: [YOUR_MODULE]          # dependencies to stage alongside it
timeout: 20s

# A background poll would otherwise swamp every step's evidence.
ignore_calls: ["YOUR_MODULE.pendingRequests"]

steps:
  - name: the app opens and offers a chain
    open: YOUR_APP_NAME
    expect:
      text: ["Chain", "Connect"]
      state: "root.phase === 'idle'"

  - name: connecting asks the wallet to approve
    click: "Connect"
    expect:
      text:
        - text: "approve the connection"
          match: contains
      state: "root.phase === 'connecting'"
      calls: ["YOUR_MODULE.connectRequest"]
```

### Everything a step can do

`click:` and `expect:` are the ones everybody finds. These exist too, and specs
are noticeably weaker without them:

```yaml
  - name: search finds the thing
    type: { into: { type: "TextField", nth: 0 }, text: "a search term" }
  - name: and opens it
    click: "Search"
    waitFor: { state: "root.navType === 'record'" }   # poll until true, don't sleep
    expect:
      state: "root.navId === '7777…'"
```

| key | what it does |
| --- | --- |
| `open:` | open the app from the sidebar |
| `click:` | click a control |
| `type: { into, text }` | type into a field — also `secret`, `clear`, `then` |
| `set: { target, property, value }` | set a QML property directly |
| `eval:` | evaluate a QML expression |
| `waitFor:` | poll `expect:`-shaped checks until they pass |
| `sleep:` | wait a fixed time (last resort) |
| `screenshot:` | capture a PNG artifact |
| `timeout:` | per-step timeout |

### Assert on state, not on text

`text:` reads the property, not the pixels, so it **finds hidden items**. Any app
that keeps screens alive instead of destroying them — a page cache, a
`StackView`, a `Popup` opened once — will keep answering for a screen the user
has left. Values like hashes and balances also change every run.

Expose what you want to assert as a property and use `state:`:

```qml
readonly property string navType: nav.type     // which screen is live
readonly property string pageError: ""         // set when a page fails to load
```

Three lines in the app buys a spec that is stable across runs and unambiguous
about what is on screen. The `pageError` one earns its keep regardless: a QML
page that fails to compile renders as an empty rectangle, and nothing reports
that unless the app does.

### Actions

One per step.

| Action | Meaning |
|---|---|
| `open: <app>` | Click the app's sidebar entry and wait for its dock. Scopes every later selector to that app. |
| `click: <selector>` | Click a control. |
| `type: {into, text, then, clear, secret}` | Focus a field, type real key events, optionally fire `accepted` (`then: enter`). `secret: true` keeps the value out of every report. |
| `set: {target, property, value}` | Set a property directly. |
| `eval: <qml expression>` | Run an expression inside your app for its side effect. |
| `wait_for: <expect>` | Block until an expectation holds. Use instead of `sleep`. |
| `sleep: <duration>` | Unconditional pause. A guess — prefer `wait_for`. |
| `screenshot: <name>` | PNG into `--artifacts`. |

Anything you type is echoed into the terminal, the JSON report and the JUnit
file, because seeing what was typed is usually the point. When it is not, say
so:

```yaml
  - name: unlock the wallet
    type:
      into: { objectName: "passwordField" }
      text: "hunter2"
      secret: true          # reports say `typed "••••••" into ...`
```

A field whose `echoMode` hides its input is masked automatically even without
it. Passing a real credential is still a bad idea — a run gets a throwaway
`$HOME`, so a literal in a setup profile can be a throwaway too. Nothing in
`SITOMETRES_*`, including `SITOMETRES_WALLET_PASSWORD`, is passed to the app
under test.

**A file dialog stops a spec dead.** Basecamp's inspector can enumerate and
drive native file dialogs, but nothing in sitometres reaches that: there is no
action for it, and a crawl that opens one will keep clicking into a modal that
swallows every gesture — which grades as a run of inert controls rather than as
the dead end it is. If your flow needs a file picker, drive it up to the dialog
and assert on what the app does after you dismiss it by hand.

### Selectors

A bare string is the visible label, matched exactly after normalising
typographic characters (so `"Loading..."` matches `Loading…`, and curly quotes
do not have to be retyped). The object form gives more control:

```yaml
click: "Send"                                  # exact label
click: { text: "Send", match: contains }       # substring
click: { text: "/^Send \\d+/", match: regex }  # pattern
click: { objectName: "sendButton" }            # stable handle — best
click: { type: "TextField", nth: 0 }           # positional — last resort
click: { text: "Send", include_hidden: true }  # match invisible controls too
```

Labels usually sit on a `Text` **inside** a `Button`, so `sitometres` resolves
the label and then clicks the nearest clickable ancestor. Hidden and disabled
controls are excluded by default; when a selector fails it tells you whether a
substring would have matched, whether the control exists but is invisible, and
which labels are nearby.

### Expectations

| Family | Key | Proves |
|---|---|---|
| UI | `text`, `not_text` | What the user can see. |
| State | `state` | A QML expression in your app's root. **Works on every build** — it needs no log evidence. It does need the app to be open, and the root is located from the `view` your manifest declares. |
| Log | `calls`, `no_calls`, `events`, `calls_succeed`, `no_errors`, `no_warnings`, `console` | What the app actually did, read from the log. |

`calls` accepts `"module.method"`, a bare `"method"`, or `"module.*"`.
`console` matches substrings of your app's own `console.log` output — often the
easiest oracle to add. `calls_succeed` and `no_errors` default to on;
`no_warnings` is opt-in. See below for exactly what each one can prove.

## Verdicts, and why there are three

```
PASS          the expectation was checked and held
FAIL          the expectation was checked and did not hold
INCONCLUSIVE  the expectation could not be checked in this session
```

The third exists because log evidence is not always reachable. Qt here is built
with journald support, so `qDebug`/`qInfo`/`qWarning` go to the systemd journal
and never touch stderr unless **`QT_FORCE_STDERR_LOGGING=1`** is set — and
Basecamp's log redirector only ever sees stderr. Same binary, same flags: 5 log
lines without it, 242 with it. `sitometres` sets it whenever it launches
Basecamp, so an owned run gets the full trail.

It cannot set it on a process it did not start. So under `--attach`, or if you
pass `forceStderrLogging: false`, log-based assertions report INCONCLUSIVE with
the remedy instead of inventing a pass:

```
  ????  connecting asks the wallet to approve     281ms
        + sees "approve the connection"
        + state "root.phase === 'connecting'"
        ? calls YOUR_MODULE.connectRequest
          this session sees no call logging (see the run header)
```

INCONCLUSIVE does not fail the build (exit code stays 0, JUnit emits
`<skipped>`), because it is a property of the session, not of your app. Use
[`--strict`](#ci) when you want that to be a failure.

**Only the log keys you wrote become INCONCLUSIVE.** The two that are on by
default — `no_errors:` and `calls_succeed:` — are *skipped* in such a session
rather than reported, deliberately, so a quiet build does not litter every step
with a verdict nobody asked for. The consequence is worth stating plainly: under
`--attach`, a step that also asserts `text:` or `state:` can report PASS while
the app threw a QML error and a backend call timed out during it. If you need
those checked in a session like that, write them out explicitly:

```yaml
    expect:
      state: "root.phase === 'connecting'"
      no_errors: true         # now INCONCLUSIVE instead of silently skipped
      calls_succeed: true
```

## What the log can and cannot prove

Worth knowing exactly, because the tool will not overstate it.

**`calls:` is trustworthy, and now covers both dispatch styles.** A synchronous
call emits `LogosAPIClient: invoking remote method "<module>" "<method>"`, which
names its own callee. `logos.callModuleAsync` emits no such line at all —
measured over the local corpus, 936 async dispatches, zero of them with it — so
those are read from `LogosAPIConsumer: async calling via
LogosObject::callMethodAsync "<method>"` and qualified with the module from the
`getToken for module:` line that precedes it. Where that context is missing the
call is reported as `?.<method>` rather than dropped. A missing call is a real
failure and the report tells you what was called instead.

**`calls_succeed:` catches hangs, not bad answers.** The only failure the
transport logs is `callRemoteMethod failed or timed out`, so that check means
"nothing hung or timed out" — and only within the step's own window. The
transport logs nothing on success, so there is no completion signal to wait on;
a hang that outlasts the step is simply not there to see. The default step
timeout is 30s, above the transport's own 20s reply timeout, so the ordinary
case does land inside the window. A call that reaches your module and comes back with
an error is **invisible in the log** — `LogosQmlBridge::callModule` returns those
to QML as a payload (`{"error":"Invalid response"}`, `"Module source
unavailable"`) and logs nothing. Verified live: calling a nonexistent method on a
loaded module produced a completely normal call trail. Assert the *effect* with
`state:` when the answer matters.

**A failure names neither module nor method.** The line is just
`callRemoteMethod failed or timed out: 1`; the method is recovered from the
transport line immediately before it. That is positional, not a correlation id,
and the report says so. Every failure in a window is reported, including ones
no dispatch could be paired with — those are named `(unknown)` rather than
dropped. And `ignore_calls:` only silences a failure it can be shown to own: a
hedged attribution whose alternatives include a call you did not ignore is
still reported.

**`no_errors` vs `no_warnings`.** A runtime `TypeError` in a binding is an error.
A missing image asset, a binding loop, or anchors inside a Layout are warnings —
real defects, but common enough that failing on them by default would be noise.
`no_errors` is on by default; turn on `no_warnings` when you want the stricter bar.

## How it decides a click worked

Basecamp's inspector **posts** mouse events rather than sending them, so a
successful `click` response means only that two events were queued — no handler
has run yet. Every step therefore:

1. marks a cursor in the log stream,
2. performs the gesture,
3. re-checks its expectations until they hold or the timeout expires.

The evidence for a step is exactly the log lines that arrived inside that
bracket, which is what makes assertions survive a chatty app: in a normal
session, one plugin's 800 ms poll accounts for more than half of all call lines.

Two details worth knowing:

- **Logs come from the child's stdout, not from disk.** Basecamp mirrors its
  output to the stdout it inherits, while the on-disk log is a buffered `QFile`
  that rotates every 10 000 lines — measured here, a file sat at 0 bytes for six
  seconds and only filled after the process exited. `--attach` has to fall back
  to the file, and is downgraded accordingly.
- **A chatty neighbour will swamp you.** One plugin's 800 ms poll accounts for
  more than half of all call lines in a normal session. Bracketing by cursor
  handles most of it; `ignore_calls:` handles the rest.
- **A reply that times out arrives long after the click.** The transport gives
  up after 20 s; the crawl watches each click for 2.5 s. So a timeout never
  lands in the window of the click that caused it. The crawl reconciles at the
  end and lists these separately, naming the click that dispatched each one
  where it can. They count towards the exit code — a run whose backend call
  failed does not report success — but they are not charged to whichever
  control happened to be under test when the timeout fired. A spec run's
  default step timeout is 30 s, above the transport's, so there it lands inside
  the window.

## Where is Basecamp?

The one thing that genuinely varies per machine. sitometres looks for
`result/bin/LogosBasecamp` in the working directory and its parents, in a
`logos-basecamp/` beside them, and in `~/logos-basecamp`. If yours lives
elsewhere, tell it once:

```bash
sitometres doctor --set-basecamp /path/to/result/bin/LogosBasecamp
```

That is remembered in `~/.config/sitometres/config.json` and used by every
later run. `--basecamp` and `$SITOMETRES_BASECAMP` override it per run, and
`sitometres doctor` always prints which one it picked and how it found it. If
nothing is found and you are on a terminal, it simply asks.

## Your real data is never touched

Two sandboxes, both automatic:

- **A throwaway Basecamp `--user-dir`** — your installed plugins, modules and
  settings are untouched. If you point `--user-dir` at a real install instead,
  staging **replaces** the directories of the app under test and of anything
  staged with it (`--with`, and its declared dependencies): those are deleted
  and rewritten from your build, because that is what staging means. Everything
  else in that user-dir is left alone. The header says which is which:

  ```
    also here  someone_elses_app, their_core (already installed, left alone)
    replaced   YOUR_APP_NAME (was installed here; staged over)
    in place   YOUR_MODULE (already installed here; tested where it lies)
  ```

  **And it puts them back.** `--user-dir <my real install>` means "test against
  my Basecamp", not "replace the app in my Basecamp": whatever was installed is
  moved aside for the run and swapped back at the end, and anything the run
  added is removed again. That holds if you Ctrl-C it — the restore rides the
  same teardown that reaps the Basecamp process. Pass `--keep-staged` when
  installing the build IS the point.

  If the copy sitometres discovered *is* the installed copy, nothing is deleted
  and nothing is copied — it is already where Basecamp will look for it, and
  that is the `in place` line. `--reset-user-dir` clears the whole user-dir
  first, and is opt-in because it is destructive; it makes no promise to undo
  itself.
- **A throwaway `$HOME`** — because `--user-dir` only re-roots what Basecamp
  itself owns, and apps keep their own state wherever they like.
  A wallet module typically keeps its store under `$HOME/.local/share/...`
  regardless of `--user-dir`, so without this a test run would drive your real
  wallet.

Isolating `$HOME` wholesale would break apps that shell out to their own tools,
so `~/.local/bin`, `~/bin`, `~/.nix-profile` and the usual `bin` directories are
symlinked through to the real ones: **tools stay available, data stays
private**. Be precise about what that buys you — a symlink is not a read-only
mount. Everything stateful (`.local/share`, `.config`, `.cache`) is private to
the run, but an app that *writes* into `~/.local/bin` during a test writes into
your real one. An app that self-updates or installs a helper mid-run is
modifying your machine.

Pass `--real-home` when you deliberately want to test against your real data —
that is also how the app sees the wallet and settings your Basecamp is already
configured with, instead of starting from onboarding.

sitometres asks nothing about wallets. Which wallet an app sees follows from
that one flag. When the run involves a wallet module it recognises, the header
states which one you got:

```
  wallet    a fresh throwaway <wallet> wallet
  wallet    your real <wallet> wallet (~/.local/share/<wallet>-home/storage.json)
```

If a test needs an *unlocked* encrypted wallet, add `--wallet-password` (or
`SITOMETRES_WALLET_PASSWORD`, since a flag is visible to `ps`). It unlocks
whichever wallet the run is already using — it does **not** switch you to your
real one, which is `--real-home` and only `--real-home`. Only wallets that have
a password are ever asked for one.

> **Wallet modules sitometres knows about.** Store paths and unlock calls differ
> per wallet, so the tool carries a small table of them (`src/app/wallet.ts`).
> Today it knows one: `medusa_core`, whose store is
> `~/.local/share/medusa-wallet-home/storage.json` and which takes a password.
> The standard Logos wallet does not, so it is never asked for one. If your app
> depends on a different wallet module, add a row there — everything else on
> this page is wallet-agnostic.

## Two things to know before you run it

**`smoke` clicks things.** Local state is sandboxed, but a wallet or messaging
app talks to the outside world and a synthesised click on *Send* can move real
funds. `smoke` skips labels that look
destructive or value-moving (`send`, `transfer`, `approve`, `export`, `delete`,
`reset`, …), but that is a heuristic over visible text — an unlabelled or
oddly-worded button will still be clicked. Point `smoke` at a testnet, and use
`--skip` for anything it misses. `run` only does what your spec says.

**Basecamp's inspector is unauthenticated and listens on every interface.**
It is `QTcpServer::listen(QHostAddress::Any, port)` — verified as
`LISTEN *:<port>` — and it exposes `evaluate`, so while a run is in progress
anyone who can reach that port can execute code inside the app. `sitometres`
prints the port in the run header and picks a random free one, but it cannot
change the bind address. Don't run tests on a network you don't trust.

## Attaching to a running Basecamp

```bash
sitometres run spec.yaml --attach 3768 --logs-dir ~/.local/share/Logos/LogosBasecampDev/logs
```

Useful for poking at an instance you already have open. Log assertions are
INCONCLUSIVE in this mode for the buffering reason above; let `sitometres`
launch the app when you want the call trail.

## CI

```bash
sitometres run spec.yaml --junit results.xml --json report.json
sitometres my_app --junit results.xml --strict
```

By default the exit code is 1 only when something actually failed — an
INCONCLUSIVE run, one whose evidence could not be read, exits 0.

**`--strict` is what closes that gap, and CI is what it is for.** It fails a run
that *proved nothing*: for `run`, an INCONCLUSIVE verdict; for a crawl, no
control did anything observable, or log evidence could not be read at all. It
does **not** fail merely because a control was `unclear` — that is the normal
outcome for most controls in a real app, and a `--strict` that failed on it
would fail every healthy crawl. Whatever makes the exit code non-zero also
appears in `--junit` and `--json`, so a red job never ships a green report.

Both artifacts are written on every path out of the command, including a
Basecamp that never started, an app that never opened, and a click that killed
it — a CI publisher reporting "no test results" is indistinguishable from a
passing run that produced nothing, which is the hole these outputs exist to
close.

## Library use

```js
import { boot, Runner, validateSpec } from "@paradoxcomputer/sitometres";
```

The inspector client, log classifier, UI snapshot and selector engine are all
exported if you want to build something else on top.

## For agents

See [Hand it to an agent](#hand-it-to-an-agent). `SKILL.md` (symlinked as
`AGENTS.md`) is the file; `npm run skill:install` puts it where Claude Code
looks.

## Licence

MIT OR Apache-2.0.
