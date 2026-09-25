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
  staged    YOUR_APP_NAME 0.1.0  local      plugins/YOUR_APP_NAME (dir, 4 min ago)                   view    3f9a1c0e5b7d2a44
            YOUR_MODULE 0.3.0    local      ../YOUR_MODULE/result/YOUR_MODULE.lgx (lgx, 12 min ago)  library 9c1e04b7aa3f5d12
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
| `open:` | open an app from the sidebar: the spec's own, or any UI app staged with `with:` |
| `click:` | click a control |
| `type: { into, text }` | type into a field, also `secret`, `clear`, `then` |
| `set: { target, property, value }` | set a QML property directly |
| `eval:` | evaluate a QML expression; `{ expr, in: <app> }` evaluates in another opened app |
| `waitFor:` | poll `expect:`-shaped checks until they pass |
| `sleep:` | wait a fixed time (last resort) |
| `screenshot:` | capture a PNG artifact |
| `timeout:` | this step's budget, action plus expectations; on an `open:` step, the open's budget |
| `command_timeout:` | the longest any one inspector command in this step may block |
| `settle:` | how long this step watches before accepting that something did not happen |

Every duration, here and in the header, is milliseconds or `500ms`, `30s`,
`2m`, `1h`, or `none` for no deadline. See [Timeouts](#timeouts).

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
| `open: <app>` | Click the app's sidebar entry and wait for its dock. Scopes every later selector, and the default root of `state:` and `eval:`, to that app. Any UI app the run staged can be named, by module name or display label; opening one already open brings it forward. |
| `click: <selector>` | Click a control. |
| `type: {into, text, then, clear, secret}` | Focus a field, type real key events, optionally fire `accepted` (`then: enter`). `secret: true` keeps the value out of every report. |
| `set: {target, property, value}` | Set a property directly. |
| `eval: <qml expression>` | Run an expression inside the current app for its side effect. `eval: { expr, in: <app> }` runs it in another app the spec has opened. |
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
| State | `state` | A QML expression in the current app's root, or `{ expr, in: <app> }` for another opened app's. **Works on every build**: it needs no log evidence. It does need the app to be open, and the root is located from the `view` your manifest declares. |
| Filesystem | `file` | That the app left something on disk: a path exists, and optionally contains a substring. Needs no log evidence, and survives the app closing. |
| Log | `calls`, `no_calls`, `events`, `calls_succeed`, `no_errors`, `no_warnings`, `console` | What the app actually did, read from the log. |

`calls` accepts `"module.method"`, a bare `"method"`, or `"module.*"`.
`console` matches substrings of your app's own `console.log` output — often the
easiest oracle to add. `calls_succeed` and `no_errors` default to on;
`no_warnings` is opt-in. See below for exactly what each one can prove.

`file` takes a path relative to the `$HOME` this run gave the app — the
throwaway one, or your real one under `--real-home` — so the same spec works
either way. It takes the three shapes `text` does:

```yaml
file: ".local/share/YOUR_APP_NAME/tips.json"           # it exists
file: { path: "exports/tips.csv", contains: "0.42" }   # and holds this
file: ["exports/tips.csv", "exports/tips.json"]        # both of them
```

`wait_for: { file: … }` is the natural way to wait for an export before
asserting what is in it.

### A flow across two apps

A dApp asks and the wallet approves: one flow, two apps, one spec. Stage the
second app with `with:`, move between the two with `open:`, and read one app's
state from the other with `in:`:

```yaml
app: tip_jar
with: [medusa_ui, medusa_core]
steps:
  - open: medusa_ui                     # its setup profile runs here, once
  - open: tip_jar
  - click: { objectName: "tipConnectButton" }
  - name: the request reaches the wallet
    wait_for:
      state: { expr: "connectSheet.visible", in: medusa_ui }   # Tip Jar stays current
  - open: medusa_ui
  - click: { objectName: "connectApproveButton" }
  - open: tip_jar
  - wait_for: { state: "root.phase === 'connected'" }
```

[`examples/tip_jar_connect.yaml`](examples/tip_jar_connect.yaml) is the whole
thing, written against the real apps.

What it does, and where it stops:

- **`open:` names any staged UI app**, the spec's own or one in `with:`, by
  module name or display label. A core module has no UI and fails at once, and
  a name nothing answers to fails listing every name that would have worked.
- **Selectors do not cross apps.** `click:`, `type:`, `set:` and `text:` belong
  to the app the spec last opened. To act in another app, open it.
- **`in:` needs the app opened first.** Before its first `open:` a `state:` with
  `in:` is INCONCLUSIVE and an `eval:` fails, each saying which `open:` is
  missing. A name that was not staged fails outright.
- **Setup profiles follow the app.** The spec app's profile runs after the spec
  app first opens, even when another app opened before it. A `with:` app's
  profile runs after that app first opens, and only one written under its own
  name counts: `.sitometres/<app>.setup.yaml`, `<app>.setup.yaml`, or a shipped
  `profiles/<app>.yaml`. `--setup` is the spec app's alone; `--no-setup` skips
  every profile. Once a second app's dock is open, a profile starts inside the
  dock of the app it belongs to, so its positional selectors and `state:` reach
  that app and not the first one in the window.
- **`--wallet-password` only ever reaches the spec app.** The unlock goes
  through the spec app's own root, after it opens, as it always has.
- **`no_errors` and `no_warnings` count every app opened so far**, and a failure
  names the app that threw.
- **The report says where each step ran.** `--json` records `app` on every step
  and `in` on every check aimed elsewhere. A spec whose `open:` steps and `in:`
  targets name more than one app also prints `in <app>` under each step and
  adds a `sitometres.app` property to each JUnit testcase. A single-app spec's
  output is unchanged.

## Timeouts

Every time budget a run spends can be set, from the spec, from a step or from
the command line, to any duration at all: `none` (or `unlimited`) means no
deadline, and there is no maximum. The defaults below are only defaults.

| budget | spec header | step | flag | default |
| --- | --- | --- | --- | --- |
| a step: its action plus its expectations | `timeout:` | `timeout:` | `--step-timeout` | 30 s, or the bridge window + 10 s when that is longer |
| one inspector command (a click, an `eval:`, a `state:` check, a snapshot) | `command_timeout:` | `command_timeout:` | `--command-timeout` | the step's `timeout:`, never less than the bridge window + 10 s |
| the Logos bridge's reply window | `call_timeout:` | | `--call-timeout` | read from the log, else 20 s |
| opening an app | `open_timeout:` | `timeout:` on the `open:` step | `--open-timeout` (else `--timeout`) | 120 s |
| watching before a clean negative check is accepted | `settle:` | `settle:` | `--settle` | 1 s (a crawl: 2.5 s per click) |
| the first paint after an app's dock appears | `open_settle:` | | | 1.2 s |
| Basecamp starting | `startup_timeout:` | | `--timeout` (`doctor --deep` too) | 120 s (30 s with `--attach`) |

**Most specific wins**: the step, then the spec's header, then the command
line, then the default. Startup is the one exception: it describes the machine,
not the app, so `--timeout` wins over `startup_timeout:`, the way `--basecamp`
wins over `basecamp:`.

**The per-command deadline follows the step.** A step's `timeout:` used to
reach only its `wait_for:` and expectation polling; every inspector command had
its own fixed 20 s, so a synchronous `logos.callModule` in an `eval:` failed at
20 s under a step that had given itself a minute. Now each command in a step
may take as long as the step, and never less than the bridge's reply window
plus 10 s. That margin matters: a synchronous call holds the GUI thread, which
is the thread that answers the inspector, until the bridge gives up, so a
deadline at or below the bridge window reports a slow backend call as a hung
app before the bridge can report its own timeout.

**The bridge window is read, not assumed.** Every synchronous dispatch line in
the log carries it (`LogosAPIConsumer: Calling invokeRemoteMethod: ...
timeout: 20000`). The largest one seen so far is used at each step, so a
Basecamp built with a longer window moves every derived default with it.
Asynchronous calls print none, and an attached session reads a log that lags,
so declare `call_timeout:` when the log cannot say. Commands outside any step
follow it too: `smoke`, `inspect` and `init` read the log again before the
open, before the wallet unlock (itself a synchronous backend call) and before
each of the crawl's clicks, and a spec's unlock is raised to the window its
app logged while opening, unless a command deadline was set. Outside a step,
a window learned from the log only ever raises the deadline: a call to a
module that is still starting carries a shorter budget of Basecamp's own.

**An `open:` is not the step's work.** A spec-level `timeout:` never governs an
open, and an open on its own budget is not charged to the step's expectations.
A budget written for the open itself (`timeout:` on the `open:` step,
`open_timeout:`, `--open-timeout`) is honoured exactly, and the sidebar click
is retried for at most a third of it so that Basecamp's launcher API still gets
a turn. The default, and `--timeout` reaching the open for compatibility, are
never less than 45 s.

**The settle is not part of the step's budget.** A clean negative check
(`no_calls:`, `no_errors:`, `not_text:`, `calls_succeed:`) is watched for its
whole `settle:` even when the action used up the step's `timeout:`, past that
deadline if need be, because a click is posted and its effect can land after
the click returns. A failing check still stops at the deadline, and positive
checks that hold are accepted at once. `settle: none` watches for the step's
whole `timeout:`.

**Startup waits for the shell, not for a log line.** Basecamp is ready when
its shell answers a probe through the inspector. The "Logos Core started
successfully" line is recorded when it appears; some builds never print it,
and waiting for it first used to spend the whole startup budget on it.

**`none` arms no timer at all**, and neither does any budget of 2^31 ms or
more: Node's `setTimeout` quietly turns those into about 1 ms, so asking for a
very long wait would otherwise get almost none. `sleep:` and `open_settle:` have
to end, so they refuse `none`; a crawl's `--settle` too.

**A long command deadline is a long wait for a hung app.** A step with
`timeout: 30m` lets each of its commands block for 30 minutes before the run
calls the app hung. When a step waits a long time for something slow, give it
a short `command_timeout:` as well, so a handler that has genuinely hung is
still noticed quickly. A poll can overshoot its step's `timeout:` by one round
of commands, each bounded by that deadline.

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

**A spec with no steps is refused outright.** `steps: []` is not a run that
proved nothing — it is a file that asks for nothing, usually one that was
truncated or whose steps are all commented out — and it used to validate
cleanly, drive nothing and exit 0 green. `run` rejects it before it launches
anything, so you learn about it in milliseconds rather than after a Basecamp
starts. A setup profile is the one exception: its `ignore_calls:` is worth
writing on its own, so a profile may have no steps.

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
timeout is the bridge's reply window plus 10 s (30 s on stock Basecamp, whose
window is 20 s), so a call the step makes can time out inside it, but only
while the step is still watching: a step whose expectations held early has
closed its window by then, and `run` does not reconcile late failures the way a
crawl does. A call that reaches your module and comes back with
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

## What a `file:` check proves

**It proves the file is there, not that this step wrote it.** It stats a path; a
file that was already there passes, exactly as `text:` passes on a label that
was already on screen. Pair it with `contains:` a value the step produced when
that matters.

**A missing file is a FAIL; a file that cannot be read is INCONCLUSIVE.**
Absence is the answer you asked for, so it fails, and the report lists what the
directory does hold. A permission error — or any errno that is not "no such
file" — is not evidence of absence, and is reported INCONCLUSIVE instead.

**Paths are scoped to the run's own directories.** A relative path resolves
against the `$HOME` the app was given. An absolute one must still land inside
that `$HOME` or the user-dir the run staged (where Basecamp keeps
`module_data/`); anywhere else is INCONCLUSIVE, not a failure — in a sandboxed
run a path under your real home can only ever be absent, and failing your app
for that would be a lie. Under `--attach` there is no such directory at all, so
`file:` reports INCONCLUSIVE with the remedy.

One hole, the same one the sandbox has generally: tool directories
(`.local/bin`, `.nix-profile`, `.cargo/bin`, …) are symlinked through to the
real ones so apps can shell out, so a `file:` under those reads your real home,
not the throwaway one.

There is deliberately no `expect: shell:` — an assertion is re-evaluated every
250 ms until the step's timeout, so a command oracle would run tens of times per
step, its meaning would depend on your `PATH` rather than on your app, and an
exit code is `ran`, not `worked`.

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
- **A reply that times out arrives long after the click.** The bridge gives
  up after its reply window (20 s on stock Basecamp, read from the log when a
  build raises it); the crawl watches each click for 2.5 s. So a timeout never
  lands in the window of the click that caused it. The crawl reconciles at the
  end and lists these separately, naming the click that dispatched each one
  where it can. They count towards the exit code — a run whose backend call
  failed does not report success — but they are not charged to whichever
  control happened to be under test when the timeout fired. A spec run's
  default step timeout is the bridge window plus 10 s, so there it lands inside
  the window of a step that is still polling.

## Which build gets tested

A repo often holds the same module twice: a fresh nix build behind `result/`,
and an older copy installed in Basecamp. The run header lists every artifact
it staged, the app first, so you never have to guess which one a verdict is
about:

```
  staged    YOUR_APP_NAME 0.1.0  local      plugins/YOUR_APP_NAME (dir, 4 min ago)                   view    3f9a1c0e5b7d2a44
            YOUR_MODULE 0.3.0    local      ../YOUR_MODULE/result/YOUR_MODULE.lgx (lgx, 12 min ago)  library 9c1e04b7aa3f5d12
```

Name and version, `local` or `installed`, the exact artifact with its form and
age, and the first 16 hex digits of a sha256. `sitometres doctor` prints the
same lines, under `would stage`, without launching anything.

**A local build beats an installed copy of the same version.** "Local" is
anything found where you ran from, or in a sibling directory beside it;
"installed" is anything under a Basecamp user-dir, `$LOGOS_USER_DIR` included.
Build times do not enter into it. They used to, and a nix store dates every
file to 1970, so an installed copy touched yesterday beat the build you made a
minute ago and the run tested the install.

The whole order, for two copies of one app:

1. a complete copy beats one missing what its manifest promises;
2. a build (`manifest.json`) beats the source tree it came from;
3. **a higher version wins, wherever it was found.** A local copy that lost this
   way gets a line of its own under the staged one, with its path;
4. local beats installed;
5. a newer build time wins, but only when both times are known;
6. otherwise the copy found first is kept, and a line under it says the two
   could not be ordered by build time.

**An unknown build time is unknown, not old.** A time within a day of the
epoch is how a nix store stamps files, so it is never compared and never
printed as an age: the line says `build time unknown`. A build behind a
`result*` out-link is dated by the link, which `nix build` writes when it
finishes. The app you pointed at is never replaced by a copy found anywhere
else; the rules above choose between the copies found where you pointed.

**What the hash proves, and what it does not.** It is taken over the file
Basecamp loads, read from the staged copy after staging: the main library for
the variant staged, or the `view` for a pure-QML plugin, and the line says
which. `--json` carries all 64 digits in `staged[]`, and `--junit` carries them
as `sitometres.staged.<name>.*` suite properties. So `sha256sum` on the staged
file during a run prints the same digits, and `doctor --deep` fails when the
run staged anything other than what `doctor` predicted. The hash identifies a
build; it does not vouch for one. Nothing here checks a signature or a package
root hash.

## Basecamp versions

sitometres works with Basecamp 0.2.x and 0.3.0. Basecamp 0.3.0 changed several of the things
sitometres reads, and it adjusts for them on its own:

- **Call failures.** 0.3.0 logs a failed or timed-out synchronous call as
  `callRemoteMethod timed out` or `callRemoteMethod failed: N` instead of 0.2.2's
  `callRemoteMethod failed or timed out: N`. Both dialects are recognised, as are 0.3.0's new
  lines for a module that cannot be reached, a call held until its module appears, and a
  deferred call that timed out.
- **Hidden channels.** 0.3.0 drops a module host's debug output, and a view module's
  backend (ui-host) output, by default. That is where events and a core module's own calls
  are logged. When sitometres launches Basecamp it turns both back on: `LOGOS_LOG_LEVEL=debug`
  (unless you set `LOGOS_LOG_LEVEL` or `SPDLOG_LEVEL` yourself) and `logos.viewhost.debug=true`
  at the front of `QT_LOGGING_RULES` (a rule you pass later still wins).
- **Honest gaps.** The run tracks each of those channels. A `calls:`/`no_calls:` check on a
  view-module app whose ui-host output never appeared, or an `events:` check when no host
  debug output appeared, is INCONCLUSIVE instead of a silent pass.
- **Handshake noise.** The token handshake 0.3.0 runs on first contact (`requestModule`,
  `informModuleToken`) is not counted as one of your app's calls.
- **Not visible on either version.** A module that answers with an error payload
  (`{"error": ...}`) logs nothing. Assert on the reply with `state:` when it matters.

Release builds (the AppImage and the portable bundles) have no QML inspector on either version,
so test against a nix dev build (`nix build .#default`). The 0.3.0 portable builds also need
glibc 2.38 or newer.

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

The artifacts also name the build they graded — where it came from, `dir` or
`lgx`, its mtime and its version — as `source` in the JSON and as
`<properties>` on the JUnit suite. Every staged artifact is there too, with the
full sha256 of the file Basecamp loaded: `staged[]` in the JSON, and
`sitometres.staged.<name>.{version,artifact,provenance,builtAt,sha256.<path>}`
properties in the JUnit. See [Which build gets tested](#which-build-gets-tested). A result kept from a red job can then still
answer "which build was that?", which the app's name and the Basecamp path
cannot when the repo holds two copies of the app.

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
exported if you want to build something else on top. So is the staging plan:
`planStaging({ cwd, app })` answers which copy of every app a run would stage,
and why each other copy lost, without launching anything.

## For agents

Off a terminal (a pipe, CI, an agent's shell) progress is narrated once per phase, to stderr, so a
run costs a reader little beyond its verdicts. `SITOMETRES_PROGRESS=all` restores one line per step
when you are chasing a hang.


See [Hand it to an agent](#hand-it-to-an-agent). `SKILL.md` (symlinked as
`AGENTS.md`) is the file; `npm run skill:install` puts it where Claude Code
looks.

## Licence

MIT OR Apache-2.0.
