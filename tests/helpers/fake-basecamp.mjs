#!/usr/bin/env node
// ---------------------------------------------------------------------------
// A Basecamp that is not Basecamp.
//
// [QmlInspector] Inspector server listening on port
//
// That line above is load-bearing, not decoration: `hasInspector` scans a
// candidate binary for exactly that byte sequence to decide whether it was
// built with the inspector, so a fake that omits it is rejected before it ever
// runs. It also has to be at least 1024 bytes long for the same check to look
// at it at all, which this comment helps with honestly enough.
//
// WHY THIS EXISTS
//
// Every verb begins `await boot(opts)` — stage the app, launch Basecamp, wait
// until it is genuinely usable — and that one line put `boot`, `launch`,
// `attach`, the readiness gate, and the whole body of every command behind a
// real Qt binary. So none of it was tested. The crawl's exit code, its five
// artifact-emitting exits and its crash attribution were reachable only by
// launching an app, which is how a green suite shipped a CI gate that exited 0
// on a broken app, twice.
//
// CONTRIBUTING says "a test must not need a Basecamp". It does not say a test
// must not need SOMETHING ON THE OTHER END OF THE SOCKET. This is that: a Node
// script that speaks the inspector's newline-delimited JSON protocol, emits log
// lines in the shapes ../src/logs/classify.ts recognises, and can be told to
// misbehave in the specific ways a real one does.
//
// It is deliberately a separate process rather than an in-process fake, because
// the things worth testing here ARE the process: that the child is spawned into
// its own group, that its stdout and stderr are pumped into the LogBuffer, that
// an exit during startup becomes a readable error rather than a connect
// timeout, and that the whole group is reaped on the way out.
//
// PROTOCOL, from ../src/inspector/protocol.ts:
//   request   {"id": <int>, "command": <string>, "params": {...}}\n
//   success   {"ok": true, ...data, "id": <int>}\n
//   failure   {"error": "<message>", "id": <int>}\n
// A response is an error IFF it carries an `error` key — there is no
// `"ok": false`.
//
// USAGE — every knob is an environment variable, so a test can shape one run
// without a second argv dialect:
//   FAKE_TREE            JSON UiNode tree to serve from getTree
//   FAKE_TREES           JSON array of trees, for an app that NAVIGATES. A node
//                        carrying `goto: <n>` switches the served tree when it
//                        is clicked, so a control can go out of reach and come
//                        back — which is what the crawl's backtracking and
//                        forward-replay exist to handle, and what a static tree
//                        can never exercise.
//   FAKE_READY_DELAY_MS  wait this long before opening the port
//   FAKE_NO_CORE_LINE    do not print "Logos Core started successfully"
//   FAKE_QUIET           print no Qt-family lines, so fidelity reads "quiet"
//   FAKE_EXIT_AFTER_MS   exit(FAKE_EXIT_CODE) after this long
//   FAKE_EXIT_CODE       default 1
//   FAKE_NO_LISTEN       never open the port at all
//   FAKE_MODULES         comma-separated module names to report as loaded
//   FAKE_SPAWN_CHILD     spawn a child process, so there is a group to reap
//   FAKE_IGNORE_SIGTERM  ignore SIGTERM, forcing stop() to escalate to SIGKILL
//   FAKE_OPEN_FAILURE    fail a backend call while the app is OPENING — after
//                        sitometres started watching, before any control was
//                        clicked, so no click window owns it
//   FAKE_CLICK_FAILS     log a call AND its failure inside the click's window,
//                        so the click itself is graded failed
//   FAKE_CLICK_HEDGE     log TWO dispatches and one failure, so the pairing is
//                        a guess: the control must not be accused
//   FAKE_TOAST           text to report as a confirmation after a click
//   FAKE_LAUNCHER        JSON array of module names Basecamp's launcher offers.
//                        A populated list that lacks the app under test is the one
//                        thing that PROVES it is absent, so openApp fails at once
//                        instead of waiting out its floor.
//   FAKE_CLICK_KILLS     exit on the Nth click, like an app crashing under one.
//                        Counted from 1, and openApp spends the first on the
//                        sidebar — so 2 is the crawl's first real control.
//   FAKE_DIE_AFTER_CLICK_MS  answer the Nth click, THEN die — so the crash
//                        surfaces in the next snapshot rather than in the click
//   FAKE_EVAL_ECHO_OBJECT  answer an evaluate with `evaluated:<objectId>:<expr>`,
//                        so a run can show WHICH root an expression reached.
//                        The default answer stays `evaluated:<expr>`
//   FAKE_CALL_WINDOW_MS  as the app opens (on the first click), log one
//                        synchronous dispatch carrying this bridge reply
//                        window, the way a Basecamp built with a longer
//                        window does. Nothing fails; the line only says it.
//
// DIALECTS. Basecamp 0.3.0 prints several lines differently from 0.2.2, and
// hides two channels unless the environment turns them on. The default is
// 0.2.2, so every test written before 0.3.0 existed keeps its meaning.
//   FAKE_DIALECT         "0.2.2" or "0.3". Set, it also prints the version
//                        banner Basecamp starts with. "0.3" means:
//                          * a sync call fails with `callRemoteMethod timed
//                            out`, not `failed or timed out: <n>`;
//                          * module-host lines are debug-level, printed only
//                            when LOGOS_LOG_LEVEL=debug, as liblogos does;
//                          * ui-host output is printed only when
//                            QT_LOGGING_RULES enables logos.viewhost.debug,
//                            in the `logos.viewhost: ui-host X : ...` shape.
//   FAKE_ECHO_ENV        print the logging switches it was launched with
//   FAKE_VIEWHOST_APP    a view module: on the first click, print the output
//                        its ui-host would, in the dialect's shape
//   FAKE_HANDSHAKE       on 0.3, precede each click's call with the token
//                        handshake a first call makes (captured lines)
//   FAKE_HELD_MODULE     on 0.3, a click also makes an async call to this
//                        module, which is held and then reported unreachable
//   FAKE_SAY_ON_SIGTERM  print this line when asked to stop, then exit
//   FAKE_LEAK_STDIO_MS   spawn a grandchild that INHERITS this process's own
//                        stdout/stderr, ignores SIGTERM, and exits on its own
//                        after this many ms. Basecamp itself still exits
//                        cleanly on SIGTERM, so stop()'s waitForExit sees a
//                        clean exit — but the inherited pipes stay open in the
//                        grandchild's hands, so drainPipes() cannot see them
//                        close and must wait out its own timeout instead.
// ---------------------------------------------------------------------------

import net from "node:net";
import { spawn } from "node:child_process";

const env = process.env;
const port = Number(env.QML_INSPECTOR_PORT ?? 0);
const userDirAt = process.argv.indexOf("--user-dir");
const userDir = userDirAt >= 0 ? process.argv[userDirAt + 1] : "(none)";

/** Basecamp writes its log to stderr; LogRedirector is what puts it there. */
const say = (line) => process.stderr.write(line + "\n");

const v030 = env.FAKE_DIALECT === "0.3";
const stamp = () => new Date().toISOString().replace("T", " ").replace("Z", "");
/** A module host's line, at the level each dialect logs its qDebug at. */
const hostSay = (module, message) => {
  if (!v030) say(`[${stamp()}] [info] [logos] [${module}] ${message}`);
  else if (env.LOGOS_LOG_LEVEL === "debug") say(`[${stamp()}] [debug] [logos] [${module}] Debug: ${message}`);
};
/** A view module's ui-host line, where each dialect forwards it (if at all). */
const uiHostSay = (module, message) => {
  if (!v030) say(`ui-host [ "${module}" ]: ${JSON.stringify(message)}`);
  else if (/logos\.viewhost\.debug=true/.test(env.QT_LOGGING_RULES ?? "")) say(`logos.viewhost: ui-host ${module} : ${message}`);
};
/** The transport giving up on a synchronous call. */
const SYNC_FAIL = v030 ? "RemoteLogosObject: callRemoteMethod timed out" : "RemoteLogosObject: callRemoteMethod failed or timed out: 20000";

const DEFAULT_TREE = {
  id: "root",
  type: "QQuickWindow",
  objectName: "",
  text: "",
  visible: true,
  enabled: true,
  children: [
    {
      id: "shell",
      type: "QQuickItem",
      objectName: "shell",
      text: "",
      visible: true,
      enabled: true,
      children: [
        { id: "settings", type: "Button_QMLTYPE_1", objectName: "settingsButton", text: "Settings", visible: true, enabled: true, children: [] },
      ],
    },
  ],
};

const trees = env.FAKE_TREES
  ? JSON.parse(env.FAKE_TREES)
  : [env.FAKE_TREE ? JSON.parse(env.FAKE_TREE) : DEFAULT_TREE];
let at = 0;

/** Every node, flattened, so findByProperty and click can address any of them. */
function flatten(node, out = []) {
  out.push(node);
  for (const c of node.children ?? []) flatten(c, out);
  return out;
}
const tree = () => trees[at];
const nodes = () => flatten(tree());
const find = (id) => nodes().find((n) => n.id === id);
let clicks = 0;

// --- the startup narrative ---------------------------------------------------
//
// Shapes taken from src/logs/classify.ts, which is itself measured against the
// corpus in ~/.local/share/Logos/LogosBasecampDev/logs. A fake that emits lines
// the classifier does not recognise would test the classifier against itself.
if (env.FAKE_DIALECT) say(`LogosBasecamp version ${v030 ? "0.3.0" : "0.2.2"} (dev build)`);
if (env.FAKE_ECHO_ENV) {
  say(`fake-basecamp env LOGOS_LOG_LEVEL=${env.LOGOS_LOG_LEVEL ?? ""} QT_LOGGING_RULES=${env.QT_LOGGING_RULES ?? ""}`);
}
say(`[QmlInspector] Inspector server listening on port ${port}`);
if (!env.FAKE_QUIET) {
  // The Qt families assessFidelity looks for. Without these it reports "quiet"
  // and every log-based assertion downgrades to INCONCLUSIVE — which is a real
  // mode worth testing, hence FAKE_QUIET.
  say("LogosAPIConsumer: requesting token for module");
  say("[LogosObject] registered");
  // A module host announcing itself, which every real Basecamp's hosts do as
  // they start: at info on 0.2.2, at debug (so only when asked for) on 0.3.0.
  hostSay("capability_module", '[LogosProviderObject] LogosAPIProvider: detected LogosProviderPlugin for "capability_module"');
}
for (const m of (env.FAKE_MODULES ?? "").split(",").filter(Boolean)) {
  say(`Module loaded: "${m}"`);
}
if (!env.FAKE_NO_CORE_LINE) say("Logos Core started successfully");
say(`using user-dir ${userDir}`);

// A child of our own, in our process group. `killOwned` signals the GROUP
// precisely because Basecamp spawns a logos_host_qt per core module, and
// killing only the parent has historically left those behind.
if (env.FAKE_SPAWN_CHILD) {
  // It dies on SIGTERM, like a well-behaved module host: stop() signals the
  // GROUP with SIGTERM and escalates only if the parent is still there, so a
  // child that ignored it would test the escalation path rather than the group
  // signal. The reaping tests use a deliberately stubborn child for that.
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},600000)"], { stdio: "ignore" });
  say(`spawned module host pid=${child.pid}`);
}

// A grandchild that inherits OUR stdout/stderr fds and outlives us on
// purpose: this process still exits cleanly on SIGTERM (so stop() sees
// `clean === true` and proceeds to drainPipes), but the pipe's write end
// stays open in the grandchild's hands until it exits on its own, so the
// parent-side stream never sees 'end'/'close' during the drain window.
if (env.FAKE_LEAK_STDIO_MS) {
  const ms = Number(env.FAKE_LEAK_STDIO_MS);
  spawn(process.execPath, ["-e", `process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});setTimeout(()=>process.exit(0),${ms})`], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}

// Refuse to go quietly, so stop() has to escalate. That path reports
// forced: true, and it exists because a hung Qt GUI thread does not answer.
if (env.FAKE_IGNORE_SIGTERM) process.on("SIGTERM", () => {});
// Say something on the way out, the way a real Basecamp's QML throws while it
// tears down, so a test can show those lines still reach the run.
else if (env.FAKE_SAY_ON_SIGTERM) {
  process.on("SIGTERM", () => {
    say(env.FAKE_SAY_ON_SIGTERM);
    process.exit(0);
  });
}

if (env.FAKE_EXIT_AFTER_MS) {
  setTimeout(() => process.exit(Number(env.FAKE_EXIT_CODE ?? 1)), Number(env.FAKE_EXIT_AFTER_MS));
}

// --- the inspector -----------------------------------------------------------

function handle(command, params) {
  switch (command) {
    case "getTree":
      return { ok: true, tree: params.objectId ? (find(params.objectId) ?? tree()) : tree() };

    case "findByProperty": {
      // The server compares values for exact equality only, and omitting the
      // value enumerates everything carrying the property — which is what
      // textInventory relies on.
      // An empty objectName is still an objectName, but textInventory filters
      // empty text itself — so only skip the property when it is absent.
      const matches = nodes()
        .filter((n) => n[params.property] !== undefined)
        .filter((n) => params.value === undefined || n[params.property] === params.value)
        .map((n) => ({ id: n.id, type: n.type, objectName: n.objectName ?? "", value: n[params.property] }));
      return { ok: true, matches, count: matches.length };
    }

    case "findByType": {
      const matches = nodes()
        .filter((n) => n.type === params.typeName)
        .map((n) => ({ id: n.id, type: n.type, objectName: n.objectName ?? "", value: n.text ?? "" }));
      return { ok: true, matches };
    }

    case "listInteractive":
      return {
        ok: true,
        matches: nodes()
          .filter((n) => /Button|MouseArea|TextField|TextInput/.test(n.type))
          .map((n) => ({ id: n.id, type: n.type, objectName: n.objectName ?? "", text: n.text ?? "" })),
      };

    case "getProperties": {
      const n = find(params.objectId);
      if (!n) return { error: `no such object: ${params.objectId}` };
      const properties = Object.entries(n)
        .filter(([k]) => k !== "children")
        .map(([name, value]) => ({ name, value }));
      return { ok: true, properties };
    }

    case "setProperty": {
      const n = find(params.objectId);
      if (!n) return { error: `no such object: ${params.objectId}` };
      n[params.property] = params.value;
      return { ok: true };
    }

    case "callMethod": {
      const n = find(params.objectId);
      if (!n) return { error: `no such object: ${params.objectId}` };
      return { ok: true, result: null };
    }

    case "findAndClick": {
      // The real server matches on the `text` property and fails when nothing
      // carries it. Answering ok regardless made every "the app never opened"
      // path unreachable: openApp believed it had clicked the sidebar entry and
      // went on to wait out its whole budget for a dock that was never coming.
      const want = String(params.text ?? "");
      const hits = nodes().filter((n) =>
        params.exact ? n.text === want : String(n.text ?? "").toLowerCase().includes(want.toLowerCase()),
      );
      if (hits.length === 0) return { error: `No object found with text: ${want}` };
      params = { ...params, objectId: hits[0].id };
      return handle("click", params);
    }

    case "click": {
      clicks++;
      // The app's own first backend call, made as it opens, and its failure.
      // Logged on the sidebar click so it lands after sitometres started
      // watching but before any control was clicked — no click window owns it,
      // which is exactly what makes it worth reporting separately.
      if (env.FAKE_VIEWHOST_APP && clicks === 1) {
        const m = env.FAKE_VIEWHOST_APP;
        uiHostSay(m, `ui-host: loaded plugin "${m}" from "/tmp/sito-userdir/plugins/${m}/${m}_plugin.so"`);
        uiHostSay(m, `ui-host: remoting enabled for "${m}"`);
      }
      if (env.FAKE_OPEN_FAILURE && clicks === 1) {
        say('LogosAPIClient: invoking remote method "demo_core" "loadState" args_count: 0');
        say('RemoteLogosObject::callMethod "loadState" args: 0');
        say(SYNC_FAIL);
      }
      if (env.FAKE_CALL_WINDOW_MS && clicks === 1) {
        say(`LogosAPIConsumer: Calling invokeRemoteMethod: "demo_core" "loadState" args_count: 0 timeout: ${env.FAKE_CALL_WINDOW_MS}`);
      }
      // Navigation. A node with `goto` switches which tree is served from here
      // on, so a control queued on one screen really does go out of reach.
      const hit = params.objectId
        ? find(params.objectId)
        : nodes().find((n) => n.text === params.text);
      if (hit && typeof hit.goto === "number") at = hit.goto;
      if (env.FAKE_CLICK_KILLS && clicks >= Number(env.FAKE_CLICK_KILLS)) {
        const after = Number(env.FAKE_DIE_AFTER_CLICK_MS ?? 0);
        if (after > 0) {
          // Answer first, then die. The crash then surfaces where a real one
          // usually does — in the NEXT snapshot, on a dead socket — which is
          // the path that has to attribute it to the control in flight rather
          // than to the one before it.
          setTimeout(() => {
            say("terminating");
            process.exit(9);
          }, after);
        } else {
          say("terminating");
          process.exit(9);
        }
      }
      // POSTED, not sent: the reply says only that events were enqueued.
      say(`LogosAPIClient: invoking remote method "demo_core" "doThing" args_count: 0`);
      if (v030 && env.FAKE_HANDSHAKE) {
        // 0.3.0 mints tokens lazily, per consumer, so a first call starts with
        // a synchronous requestModule of its own (captured verbatim).
        say('LogosAPIClient: getToken for module: "demo_core"');
        say('LogosAPIClient: No token found for module: "demo_core"');
        say('LogosAPIClient: calling requestModule for "demo_core"');
        say('LogosAPIClient: getToken for module: "capability_module"');
        say('LogosAPIClient: Found token for module: "capability_module"');
        say('LogosAPIConsumer: requestModule for origin: "demo_ui" target: "demo_core" budget: 19997 ms');
        say('RemoteTransportConnection: Requesting object: "capability_module" at "22:58:45.363"');
        say('[LogosObject] RemoteLogosObject::callMethod "requestModule" args: 2');
        say('LogosAPIClient: requestModule result for "demo_core" : "00000000-0000-4000-8000-000000000000"');
        say('LogosAPIConsumer: Calling invokeRemoteMethod: "demo_core" "doThing" args_count: 0 timeout: 20000');
      }
      if (v030 && env.FAKE_HELD_MODULE) {
        const m = env.FAKE_HELD_MODULE;
        say(`LogosAPIConsumer: '"${m}"::""' deferred pending the module becoming reachable`);
        say(
          `LogosAPIConsumer: '"${m}"::""' still not reachable after 3592 ms -- subscription is DEFERRED, not lost; ` +
            "it will arm when the module appears. Is the module loaded?",
        );
      }
      if (env.FAKE_CLICK_HEDGE) {
        // Two dispatches in flight and one failure: which of them failed cannot
        // be known, so the control must not be accused — the run counts it, the
        // grade stays `unclear`, and the hedge stays visible.
        say(`LogosAPIClient: invoking remote method "demo_core" "alsoThis" args_count: 0`);
        say('RemoteLogosObject::callMethod "doThing" args: 0');
        say('RemoteLogosObject::callMethod "alsoThis" args: 0');
        say(SYNC_FAIL);
      } else if (env.FAKE_CLICK_FAILS) {
        say('RemoteLogosObject::callMethod "doThing" args: 0');
        say(SYNC_FAIL);
      }
      return { ok: true, posted: 2 };
    }

    case "sendKeys":
      return { ok: true, sent: String(params.text ?? "").length };

    case "evaluate":
      // A real Basecamp logs while it is being driven, so a failure that prints
      // the log tail has something to print. Not a call line: the crawl counts
      // those as evidence, and this must not look like one.
      say("[LogosObject] evaluated an expression for the inspector");
      // The sidebar's launcher list, when a test wants openApp to consult it.
      if (env.FAKE_LAUNCHER && /launcherApps/.test(String(params.expression ?? ""))) {
        return { ok: true, result: JSON.stringify(JSON.parse(env.FAKE_LAUNCHER).map((name) => ({ name }))), undefined: false };
      }
      // The real server evaluates the expression in the object's context. A
      // fake cannot, so it answers truthily and records what it was asked —
      // which is enough to catch the argument-order bug that shipped here.
      if (env.FAKE_EVAL_ECHO_OBJECT) {
        return { ok: true, result: `evaluated:${params.objectId ?? ""}:${params.expression}`, undefined: false };
      }
      return { ok: true, result: `evaluated:${params.expression}`, undefined: false };

    case "screenshot":
      return { ok: true, image: Buffer.from("not really a png").toString("base64") };

    case "listFileDialogs":
      // The older of the two revisions in the wild does not have it, and
      // probeCapabilities uses exactly this to tell them apart.
      return env.FAKE_OLD_INSPECTOR ? { error: "Unknown command: listFileDialogs" } : { ok: true, dialogs: [] };

    default:
      return { error: `Unknown command: ${command}` };
  }
}

if (!env.FAKE_NO_LISTEN) {
  const server = net.createServer((sock) => {
    let buffer = "";
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        let res;
        try {
          res = handle(req.command, req.params ?? {});
        } catch (err) {
          res = { error: String(err && err.message ? err.message : err) };
        }
        sock.write(JSON.stringify({ ...res, id: req.id }) + "\n");
      }
    });
    sock.on("error", () => {});
  });
  const open = () => server.listen(port, "127.0.0.1");
  if (env.FAKE_READY_DELAY_MS) setTimeout(open, Number(env.FAKE_READY_DELAY_MS));
  else open();
}

// Stay up until signalled, the way a GUI application does.
setInterval(() => {}, 1 << 30);
