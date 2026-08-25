// The TCP transport had no test of any kind, and everything a verdict is
// written about arrives through it.
//
// The defect this file is built around shipped. The socket decoded each chunk
// with `chunk.toString("utf8")`, so a character straddling a TCP read boundary
// became U+FFFD in *both* halves. The JSON still parsed and nothing threw, so
// the damage came out as a label that no longer matched the selector naming
// it — a false FAIL for text genuinely on screen, with the mojibake handed
// back as the did-you-mean. For a CJK or Cyrillic app essentially every
// capture corrupted. The fix (a StringDecoder held across reads) was recorded
// as "exercised by every existing capture", which was untrue: reverting it
// left the whole suite green. The corrected record then pointed at
// tests/streamdecoding.test.mjs, which has never existed either. "a label
// whose character is split across two tcp reads comes back byte for byte"
// below is that test at last: revert attach() to chunk.toString() and it is
// the one test in this file that fails. (The other decoder, the log stream
// pump in src/logs/source.ts, is still not covered here.)
//
// Everything here drives the real client against a net.createServer on
// 127.0.0.1:0 speaking the newline-JSON protocol from ../src/inspector/
// protocol.ts. No Basecamp, no fixed port. Every test carries a short timeout
// so a transport that hangs fails this file rather than wedging the suite.
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";

import {
  InspectorClient,
  sleep,
  DEFAULT_INSPECTOR_HOST,
  DEFAULT_INSPECTOR_PORT,
} from "../dist/inspector/client.js";
import { InspectorError, InspectorTransportError } from "../dist/inspector/protocol.js";

/**
 * A fake inspector: newline-delimited JSON in, whatever `onRequest` writes out.
 * Records every request line it decoded so a test can assert on the wire, not
 * just on the reply.
 *
 * `opts.port` binds a chosen port instead of asking for a free one, which only
 * waitUntilListening needs: to watch a port that is shut and then opens, a test
 * has to reopen the exact port it was already polling.
 */
async function fakeInspector(t, onRequest, opts = {}) {
  const requests = [];
  const sockets = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.setNoDelay(true);
    sock.on("error", () => {}); // a client destroying its end is not a failure here
    const decoder = new StringDecoder("utf8");
    let buf = "";
    sock.on("data", (chunk) => {
      buf += decoder.write(chunk);
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const req = JSON.parse(line);
        requests.push(req);
        onRequest(req, sock);
      }
    });
  });
  await new Promise((resolve, reject) => {
    // Reject rather than let an EADDRINUSE reach an unhandled "error" event:
    // asking for a specific port can lose a race with anything else on the
    // machine, and that has to read as the errno it is, not as a crash.
    const onListenError = (err) => reject(err);
    server.once("error", onListenError);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.off("error", onListenError);
      resolve();
    });
  });
  // t.after, not a finally: a test that times out is cancelled where it stands
  // and its finally never runs, so a hung transport would leave the socket open
  // and node would sit on the live handle instead of failing the file.
  let closed = false;
  t.after(() => close());
  async function close() {
    if (closed) return;
    closed = true;
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  return {
    port: server.address().port,
    requests,
    connections: () => sockets.length,
    close,
  };
}

const line = (obj) => JSON.stringify(obj) + "\n";

/** Reply "ok" to whatever was asked, echoing the id as the server does. */
const ok = (req, data) => line({ ok: true, ...data, id: req.id });

const T = { timeout: 5000 };

test("a request goes out as one line of json and the reply comes back parsed", T, async (t) => {
  const server = await fakeInspector(t, (req, sock) => {
    if (req.command === "findAndClick") {
      sock.write(
        ok(req, {
          clicked: true,
          x: 120,
          y: 34,
          widget: "QQuickWidget",
          matchedText: "Отправить",
          matchedType: "Button_QMLTYPE_59",
          matchedId: "42",
        }),
      );
    } else {
      setTimeout(() => sock.write(ok(req, { tree: { type: "QQuickView", children: [] } })), 60);
    }
  });
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2000 });
  t.after(() => client.disconnect());
  const res = await client.findAndClick("Отправить", { type: "Button", exact: true });

  // The wire, not just the answer: the command name, the parameter names and
  // the id are the whole contract with inspectorserver.cpp.
  assert.deepEqual(server.requests, [
    { id: 0, command: "findAndClick", params: { text: "Отправить", type: "Button", exact: true } },
  ]);
  assert.equal(res.matchedId, "42");
  assert.equal(res.matchedText, "Отправить");
  assert.equal(res.x, 120);
  assert.equal(res.widget, "QQuickWidget");

  // elapsedMs is measured from write to reply. A getTree held for 60ms must
  // report roughly that, not zero — the runner attributes step latency with it.
  const timed = await client.sendTimed("getTree", { depth: 2 });
  assert.deepEqual(timed.data.tree, { type: "QQuickView", children: [] });
  assert.ok(timed.elapsedMs >= 45, `elapsedMs was ${timed.elapsedMs}, expected the ~60ms the server held it`);
  assert.ok(timed.elapsedMs < 2000);
  assert.deepEqual(server.requests[1], { id: 1, command: "getTree", params: { depth: 2 } });
});

test("a reply is matched to its own request by id, not by arrival order", T, async (t) => {
  // Commands are dispatched from the GUI thread in order, but nothing in the
  // client may depend on that: correlation is by id. Answering the second
  // request first must not hand its payload to the first caller — that would
  // put another widget's geometry into the wrong step's evidence.
  const server = await fakeInspector(t, (req, sock) => {
    const reply = ok(req, { properties: [{ name: "text", value: req.params.objectId === "1" ? "first" : "second" }] });
    setTimeout(() => sock.write(reply), req.params.objectId === "1" ? 80 : 5);
  });
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2000 });
  t.after(() => client.disconnect());
  await client.connect();
  const [a, b] = await Promise.all([client.getProperties("1"), client.getProperties("2")]);
  assert.equal(a.properties[0].value, "first");
  assert.equal(b.properties[0].value, "second");
  assert.equal(a.id, 0, "the reply carrying id 0 is the one the first call resolved with");
  assert.equal(b.id, 1);
});

test("a label whose character is split across two tcp reads comes back byte for byte", T, async (t) => {
  // THE regression. Split a reply inside the two bytes of "п" and inside the
  // three bytes of "信" and write the pieces with a gap, so the client's socket
  // sees three separate reads with a half character on each seam. With the
  // StringDecoder the halves are held and rejoined; with chunk.toString("utf8")
  // — what this code shipped with — each seam becomes U+FFFD twice, the JSON
  // still parses, and the runner reports a false FAIL against a label that is
  // on screen. Reverting attach() to chunk.toString() fails this test and
  // nothing else in this file, which is the shape a regression test wants: it
  // names one defect.
  const cyrillic = "Отправить";
  const cjk = "送信する";
  const payloadFor = (id) =>
    Buffer.from(
      line({
        ok: true,
        count: 2,
        matches: [
          { id: "11", type: "Text_QMLTYPE_7", objectName: "sendLabel", value: cyrillic },
          { id: "12", type: "Text_QMLTYPE_7", objectName: "jpLabel", value: cjk },
        ],
        id,
      }),
      "utf8",
    );

  /** Cut `buf` one byte into each named character, so every seam is mid-character. */
  function splitInsideChars(buf, chars) {
    const cuts = chars
      .map((c) => {
        const at = buf.indexOf(Buffer.from(c, "utf8"));
        assert.ok(at > 0, `fixture must contain ${c}`);
        return at + 1;
      })
      .sort((x, y) => x - y);
    for (const c of cuts) {
      assert.equal(buf[c] & 0xc0, 0x80, "a cut must land on a continuation byte, i.e. inside a character");
    }
    const parts = [];
    let prev = 0;
    for (const c of cuts) {
      parts.push(buf.subarray(prev, c));
      prev = c;
    }
    parts.push(buf.subarray(prev));
    return parts;
  }

  // Guard the fixture itself: if the halves happened to decode cleanly on their
  // own, this test would pass against the broken code and prove nothing.
  const naive = splitInsideChars(payloadFor(0), ["п", "信"])
    .map((p) => p.toString("utf8"))
    .join("");
  assert.notEqual(naive, payloadFor(0).toString("utf8"));
  assert.match(naive, /�/, "each seam must corrupt when decoded per chunk");
  assert.ok(!naive.includes(cyrillic), "decoded per chunk, the cyrillic label is exactly what is lost");
  assert.ok(!naive.includes(cjk), "and the CJK one");

  const server = await fakeInspector(t, (req, sock) => {
    void (async () => {
      for (const part of splitInsideChars(payloadFor(req.id), ["п", "信"])) {
        sock.write(part);
        await sleep(30);
      }
    })();
  });
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 3000 });
  t.after(() => client.disconnect());
  const inventory = await client.textInventory();
  assert.equal(inventory.length, 2);
  assert.equal(inventory[0].text, "Отправить", "the cyrillic label must survive the seam inside п");
  assert.equal(inventory[1].text, "送信する", "and the CJK one the seam inside 信");
  assert.equal(inventory[0].objectName, "sendLabel");
  assert.ok(!JSON.stringify(inventory).includes("�"), "nothing anywhere may have become a replacement character");
});

test("an error reply becomes an InspectorError carrying the command, the server's words and the params", T, async (t) => {
  // A response is an error iff it carries an `error` key — there is no
  // "ok": false. Treating one as data would let a step read `undefined` out of
  // a failure and report it as evidence.
  const message = "No clickable element found with text 'Отправить'";
  const server = await fakeInspector(t, (req, sock) => sock.write(line({ error: message, id: req.id })));
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2000 });
  t.after(() => client.disconnect());
  await assert.rejects(
    () => client.findAndClick("Отправить", { exact: true }),
    (err) => {
      assert.ok(err instanceof InspectorError);
      assert.ok(!(err instanceof InspectorTransportError), "the app answering no is not a dead socket");
      assert.equal(err.command, "findAndClick");
      assert.equal(err.serverMessage, message, "the server's own words, unparaphrased — the report quotes them");
      assert.equal(err.message, `inspector findAndClick failed: ${message}`);
      assert.deepEqual(err.params, { text: "Отправить", exact: true }, "what was asked, so the failure is reproducible");
      return true;
    },
  );
  // and the socket is still usable: an application-level no is not fatal.
  assert.equal(client.connected, true);
});

test("a server that hangs up mid-request fails the call instead of hanging", T, async (t) => {
  // When the app dies the socket closes with the command still in flight. If
  // the close is not turned into a rejection the caller waits out the whole
  // 20s deadline for an answer that can never arrive, and a crashed app looks
  // like a slow one.
  const server = await fakeInspector(t, (_req, sock) => sock.end());
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 30_000 });
  t.after(() => client.disconnect());
  const started = Date.now();
  await assert.rejects(
    () => client.getTree(),
    (err) => {
      assert.ok(err instanceof InspectorTransportError);
      assert.equal(err.name, "InspectorTransportError");
      assert.equal(err.message, "inspector closed the connection (did the app exit?)");
      return true;
    },
  );
  assert.ok(Date.now() - started < 3000, "it must fail on the close, not on the 30s deadline");
});

test("once the connection has died the next call repeats the real cause rather than reconnecting", T, async (t) => {
  // The port stays open after the app's window is gone, so a silent reconnect
  // would hand back a fresh session and let the run carry on against nothing.
  // The stored fatal error is what stops that, and it names what actually
  // happened instead of a generic "not connected".
  const server = await fakeInspector(t, (_req, sock) => sock.end());
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 30_000 });
  t.after(() => client.disconnect());
  await assert.rejects(() => client.getTree(), InspectorTransportError);
  assert.equal(client.connected, false);
  await assert.rejects(
    () => client.listInteractive(),
    (err) => {
      assert.equal(err.message, "inspector closed the connection (did the app exit?)");
      return true;
    },
  );
  assert.equal(server.requests.length, 1, "the second call must not have reached the wire");
  assert.equal(server.connections(), 1, "and must not have opened a second connection");
});

test("a command with no reply gives up at the deadline and names the command", T, async (t) => {
  // A synchronous handler on the GUI thread can block the socket forever. The
  // deadline is the only thing that ends the step, and the message has to say
  // which command stalled or the report blames the wrong one.
  let stalled = null;
  const server = await fakeInspector(t, (req, sock) => {
    if (req.command === "getTree") {
      stalled = { sock, id: req.id }; // deliberately never answered in time
      return;
    }
    sock.write(ok(req, { elements: [], count: 0 }));
  });
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 120 });
  t.after(() => client.disconnect());
  await assert.rejects(
    () => client.getTree({ depth: 3 }),
    (err) => {
      assert.ok(err instanceof InspectorTransportError);
      assert.match(err.message, /^inspector command "getTree" timed out after 120ms\./);
      assert.match(err.message, /GUI thread/, "the message has to explain why a hung handler blocks everything");
      return true;
    },
  );

  // The app then answers, long after the caller gave up. A reply nobody is
  // waiting for is dropped — resolving it into whoever is next would give a
  // later step the previous step's tree, and dereferencing the absent
  // pending entry would kill the socket handler outright.
  stalled.sock.write(line({ ok: true, tree: { type: "QQuickView" }, id: stalled.id }));
  await sleep(30);
  assert.equal(client.connected, true, "a late reply must not tear the connection down");
  assert.deepEqual(await client.listInteractive(), [], "and the client is still usable");
});

test("a non-json line on the port is surfaced, truncated, not silently dropped", T, async (t) => {
  // 3768 is a plain TCP port and something else can be sitting on it. Dropping
  // lines that do not parse would leave the call to time out 20s later with no
  // hint of what was actually there; JSON.parse throwing inside the data
  // handler instead would take down the process with it.
  const noise = "x".repeat(300);
  const server = await fakeInspector(t, (_req, sock) => sock.write(noise + "\n"));
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2000 });
  t.after(() => client.disconnect());
  await assert.rejects(
    () => client.screenshot(),
    (err) => {
      assert.ok(err instanceof InspectorTransportError);
      assert.equal(err.message, `unparseable line from inspector: ${"x".repeat(200)}…`);
      return true;
    },
  );
});

test("an older revision is probed once and its missing commands are not sent", T, async (t) => {
  // Both revisions are in the wild. The older one has no file-dialog commands
  // and keys listInteractive `matches`; probing on every call would cost a
  // round trip per step, and sending a command it cannot answer turns a
  // missing feature into an error the user cannot act on.
  const server = await fakeInspector(t, (req, sock) => {
    if (req.command === "listFileDialogs") {
      sock.write(line({ error: "Unknown command: listFileDialogs", id: req.id }));
    } else if (req.command === "listInteractive") {
      sock.write(ok(req, { matches: [{ id: "9", type: "Button_QMLTYPE_59", objectName: "send", text: "Отправить", enabled: true }], count: 1 }));
    } else {
      sock.write(line({ error: `Unknown command: ${req.command}`, id: req.id }));
    }
  });
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2000 });
  t.after(() => client.disconnect());
  assert.deepEqual(await client.listFileDialogs(), [], "no dialogs, not an error");
  assert.deepEqual(await client.listFileDialogs(), []);
  assert.equal(
    server.requests.filter((r) => r.command === "listFileDialogs").length,
    1,
    "capabilities are probed once and remembered",
  );

  await assert.rejects(
    () => client.fileDialogAction("7", "accept"),
    (err) => {
      assert.ok(err instanceof InspectorTransportError, "a build that predates the feature is not an app failure");
      assert.match(err.message, /predates file-dialog support/);
      assert.match(err.message, /rebuild/);
      return true;
    },
  );
  assert.equal(server.requests.filter((r) => r.command === "fileDialogAction").length, 0, "and it never went out");

  const interactive = await client.listInteractive();
  assert.equal(interactive.length, 1, "the older revision's `matches` key must still be read");
  assert.equal(interactive[0].text, "Отправить");
  assert.equal(interactive[0].id, "9");
});

test("a newer revision answers with its dialogs and fileDialogAction carries the extras", T, async (t) => {
  const server = await fakeInspector(t, (req, sock) => {
    if (req.command === "listFileDialogs") {
      sock.write(ok(req, { dialogs: [{ id: "77", type: "QQuickFileDialog", title: "Открыть" }] }));
    } else if (req.command === "listInteractive") {
      sock.write(ok(req, { elements: [{ id: "3", type: "MouseArea", objectName: "tile" }], count: 1 }));
    } else {
      sock.write(ok(req, { accepted: true }));
    }
  });
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2000 });
  t.after(() => client.disconnect());
  const dialogs = await client.listFileDialogs();
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].id, "77");
  assert.equal(dialogs[0].title, "Открыть");

  await client.fileDialogAction("77", "selectFile", { path: "/tmp/receipt.pdf" });
  const sent = server.requests.find((r) => r.command === "fileDialogAction");
  assert.deepEqual(
    sent.params,
    { objectId: "77", action: "selectFile", path: "/tmp/receipt.pdf" },
    "the extras are spread alongside, not nested under a key the server ignores",
  );

  const interactive = await client.listInteractive();
  assert.equal(interactive.length, 1, "the newer revision's `elements` key must be read too");
  assert.equal(interactive[0].type, "MouseArea");
});

test("textInventory asks for every text-bearing object and drops the ones with nothing on them", T, async (t) => {
  // The value is omitted from the request on purpose: the server only compares
  // for equality, so substring, regex and did-you-mean all depend on getting
  // the whole inventory back in one call. Sending a value would return only
  // exact hits and every near-miss suggestion would vanish.
  const server = await fakeInspector(t, (req, sock) =>
    sock.write(
      ok(req, {
        count: 4,
        matches: [
          { id: "1", type: "Text_QMLTYPE_7", objectName: "title", value: "Отправить" },
          { id: "2", type: "Label_QMLTYPE_9", objectName: "count", value: 42 },
          { id: "3", type: "Text_QMLTYPE_7", objectName: "blank", value: "" },
          { id: "4", type: "Text_QMLTYPE_7", objectName: "unset", value: null },
        ],
      }),
    ),
  );
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2000 });
  t.after(() => client.disconnect());
  const inventory = await client.textInventory();
  assert.deepEqual(server.requests[0].params, { property: "text" }, "no value: enumerate everything");
  assert.deepEqual(
    inventory.map((m) => [m.id, m.text]),
    [
      ["1", "Отправить"],
      ["2", "42"],
    ],
    "a numeric label is usable text; an empty or absent one is not a label at all",
  );
  assert.equal(typeof inventory[1].text, "string", "a number must be rendered, or substring matching throws on it");
});

test("a refused port is reported as the address it tried, with the errno underneath", T, async (t) => {
  // "connection refused" on its own has sent people hunting for the wrong app.
  // The address is what tells them the port was overridden or the build lacks
  // ENABLE_QML_INSPECTOR.
  const idle = await fakeInspector(t, () => {});
  const port = idle.port;
  await idle.close();

  const client = new InspectorClient({ host: "127.0.0.1", port, timeoutMs: 500 });
  t.after(() => client.disconnect());
  await assert.rejects(
    () => client.connect(),
    (err) => {
      assert.ok(err instanceof InspectorTransportError);
      assert.ok(
        err.message.startsWith(`cannot reach the QML inspector at 127.0.0.1:${port} — `),
        `message was ${err.message}`,
      );
      assert.equal(err.cause?.code, "ECONNREFUSED", "the underlying errno survives for the doctor to print");
      return true;
    },
  );
  assert.equal(client.connected, false);
});

test("the app saying no and the socket dying are different types, each carrying its fields", T, () => {
  // probeCapabilities distinguishes the two by instanceof and then reads
  // serverMessage; a caller that cannot tell them apart would retry a genuine
  // application error as if the socket had glitched, or give up on a glitch as
  // if the app had refused.
  const err = new InspectorError("evaluate", "Object not found: 99", { expression: "root.total" });
  assert.ok(err instanceof Error);
  assert.equal(err.name, "InspectorError");
  assert.equal(err.command, "evaluate");
  assert.equal(err.serverMessage, "Object not found: 99");
  assert.equal(err.message, "inspector evaluate failed: Object not found: 99");
  assert.deepEqual(err.params, { expression: "root.total" });
  assert.ok(!(err instanceof InspectorTransportError));

  const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3768"), { code: "ECONNREFUSED" });
  const transport = new InspectorTransportError("cannot reach the QML inspector at 127.0.0.1:3768", cause);
  assert.ok(transport instanceof Error);
  assert.equal(transport.name, "InspectorTransportError");
  assert.equal(transport.message, "cannot reach the QML inspector at 127.0.0.1:3768");
  assert.equal(transport.cause, cause, "the original error is kept, not flattened into the message");
  assert.ok(!(transport instanceof InspectorError));
});

test("the address comes from the option, then the environment, then the default", T, () => {
  // A second Basecamp on another port is driven with QML_INSPECTOR_PORT and
  // nothing else; losing that fallback silently sends every command to 3768,
  // i.e. to the wrong app, and the run still goes green.
  const saved = { host: process.env.QML_INSPECTOR_HOST, port: process.env.QML_INSPECTOR_PORT };
  try {
    delete process.env.QML_INSPECTOR_HOST;
    delete process.env.QML_INSPECTOR_PORT;
    const bare = new InspectorClient();
    assert.equal(bare.host, DEFAULT_INSPECTOR_HOST);
    assert.equal(bare.port, DEFAULT_INSPECTOR_PORT);
    assert.equal(bare.host, "127.0.0.1", "never 0.0.0.0 or localhost — the inspector binds loopback v4");
    assert.equal(bare.port, 3768);

    process.env.QML_INSPECTOR_HOST = "192.0.2.9";
    process.env.QML_INSPECTOR_PORT = "4001";
    const fromEnv = new InspectorClient();
    assert.equal(fromEnv.host, "192.0.2.9");
    assert.equal(fromEnv.port, 4001);
    assert.equal(typeof fromEnv.port, "number", "a string port would be handed straight to net.connect");

    const explicit = new InspectorClient({ host: "127.0.0.1", port: 5555 });
    assert.equal(explicit.port, 5555, "an explicit option outranks the environment");
    assert.equal(explicit.host, "127.0.0.1");
  } finally {
    for (const [k, v] of [["QML_INSPECTOR_HOST", saved.host], ["QML_INSPECTOR_PORT", saved.port]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---------------------------------------------------------------------------
// The second half of this file covers what never ran at all: the three
// waitUntilListening paths, the socket's own error handler, and the wrappers
// clickRef, clickAt, findByType, setProperty, callMethod, sendKeys and
// evaluate. Being thin is exactly why they need pinning — a wrapper is a
// command name and a params object, both typed out by hand, and getting either
// wrong produces no type error and no exception.
//
// `evaluate` shipped with its two arguments reversed: `evaluate(expr, rootId)`
// put the object id where the expression goes, so the app was asked to evaluate
// "17". Every `state:` check, the wallet unlock in ../src/app/wallet.ts and the
// debug REPL's `state` command go through it, and the app's ReferenceError came
// back quoted at the user as though their expression were the broken thing.
//
// So each test below asserts the request the server received, field by field,
// and each fake answers the way inspectorserver.cpp answers — an unknown object
// id is an error, an unknown type is an empty match list, a missing `args` is a
// refusal — so a swapped or dropped field fails the way the app fails and not
// merely as a diff.
// ---------------------------------------------------------------------------

test("waitUntilListening returns as soon as the port answers, and keeps the connection it opened", T, async (t) => {
  // Two costs of getting this wrong, both paid on every single run: sleeping
  // before the first attempt adds the poll interval to app startup, and closing
  // the probe connection to reconnect for the first command opens a second
  // session against an inspector that serves them from the GUI thread.
  const server = await fakeInspector(t, (req, sock) => sock.write(ok(req, { tree: { type: "QQuickView" } })));
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2000 });
  t.after(() => client.disconnect());

  const started = Date.now();
  await client.waitUntilListening({ timeoutMs: 3000, intervalMs: 2000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `an already-open port must cost no poll interval; waiting took ${elapsed}ms`);
  assert.equal(client.connected, true);

  assert.deepEqual((await client.getTree()).tree, { type: "QQuickView" });
  assert.equal(server.connections(), 1, "the connection the poll opened is the one the commands then go down");
});

test("a port that opens only after the app is up is polled until it does", T, async (t) => {
  // Basecamp's inspector binds when its QML engine finishes constructing, which
  // on a cold start is seconds after the process exists — lifecycle.ts calls
  // this immediately after spawn. Giving up on the first ECONNREFUSED would
  // fail every run at attach; that is the whole reason this is a poll.
  const probe = await fakeInspector(t, () => {});
  const port = probe.port;
  await probe.close(); // nothing is listening on `port` now

  const client = new InspectorClient({ host: "127.0.0.1", port, timeoutMs: 2000 });
  t.after(() => client.disconnect());
  const started = Date.now();
  const waiting = client.waitUntilListening({ timeoutMs: 4000, intervalMs: 40 });
  await sleep(200);
  assert.equal(client.connected, false, "nothing to connect to yet, and it must still be trying");

  const server = await fakeInspector(t, (req, sock) => sock.write(ok(req, { elements: [], count: 0 })), { port });
  await waiting;
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 200, `it cannot have connected before the port existed; it resolved after ${elapsed}ms`);
  assert.equal(client.connected, true);
  assert.deepEqual(await client.listInteractive(), [], "and what it hands back is a usable session");
  assert.equal(server.connections(), 1);
});

test("waitUntilListening gives up at its own deadline, blames the build flag and keeps the errno", T, async (t) => {
  // The commonest cause by far is a Basecamp built without
  // ENABLE_QML_INSPECTOR=ON: the port never opens, and without that sentence the
  // run reports a bare connection refusal a minute later and the reader goes
  // hunting for a crashed app. The deadline is the one passed in, not the
  // client's own per-command timeoutMs — they are different numbers here on
  // purpose — and the last connect failure is carried as the cause so `doctor`
  // can print the errno underneath.
  const idle = await fakeInspector(t, () => {});
  const port = idle.port;
  await idle.close();

  const client = new InspectorClient({ host: "127.0.0.1", port, timeoutMs: 5000 });
  t.after(() => client.disconnect());
  const started = Date.now();
  await assert.rejects(
    () => client.waitUntilListening({ timeoutMs: 150, intervalMs: 30 }),
    (err) => {
      assert.ok(err instanceof InspectorTransportError);
      assert.equal(
        err.message,
        `QML inspector never came up on 127.0.0.1:${port} within 150ms. ` +
          `Is Basecamp built with the inspector enabled (ENABLE_QML_INSPECTOR=ON)?`,
      );
      assert.equal(err.cause?.cause?.code, "ECONNREFUSED", "the last attempt's errno survives both wrappings");
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 150, `it must spend its deadline retrying, not fail on the first refusal after ${elapsed}ms`);
  assert.ok(elapsed < 2000, "and it must stop at the deadline it was given, not at the per-command timeout");
  assert.equal(client.connected, false);
});

test("clickRef and clickAt both send \"click\", told apart only by their params", T, async (t) => {
  // Neither method name exists on the wire: there is one `click` command, and
  // which of the three param shapes goes out is the entire difference between
  // clicking an icon-only button by id — the reason clickRef exists, since
  // findAndClick can only reach text-bearing objects — and clicking a bare
  // coordinate. The fake resolves an id through a geometry registry the way the
  // server does, so a dropped offset comes back as the item's centre and an
  // unknown id comes back as the server's own error.
  const geometry = { "42": { x: 100, y: 200, width: 80, height: 20 } };
  const server = await fakeInspector(t, (req, sock) => {
    const { objectId, x, y } = req.params;
    if (objectId === undefined) {
      sock.write(ok(req, { clicked: true, x, y, widget: "QQuickWidget" }));
      return;
    }
    const g = geometry[objectId];
    if (!g) {
      sock.write(line({ error: `No object with id ${objectId}`, id: req.id }));
      return;
    }
    const at = x === undefined ? { x: g.x + g.width / 2, y: g.y + g.height / 2 } : { x: g.x + x, y: g.y + y };
    sock.write(ok(req, { clicked: true, ...at, widget: "Button_QMLTYPE_59" }));
  });
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2000 });
  t.after(() => client.disconnect());

  const centre = await client.clickRef("42");
  assert.deepEqual(server.requests[0], { id: 0, command: "click", params: { objectId: "42" } });
  assert.equal(centre.x, 140, "no offset means the server picked the point, from the id alone");
  assert.equal(centre.y, 210);
  assert.equal(centre.widget, "Button_QMLTYPE_59");

  const offset = await client.clickRef("42", { x: 4, y: 6 });
  assert.deepEqual(
    server.requests[1],
    { id: 1, command: "click", params: { objectId: "42", x: 4, y: 6 } },
    "the offset is spread flat beside the id, not nested under an `at` key the server would ignore",
  );
  assert.equal(offset.x, 104, "both halves of the offset reached the server");
  assert.equal(offset.y, 206);

  const raw = await client.clickAt(300, 12);
  assert.deepEqual(server.requests[2], { id: 2, command: "click", params: { x: 300, y: 12 } });
  assert.equal(raw.x, 300);
  assert.equal(raw.y, 12);
  assert.equal(raw.widget, "QQuickWidget", "with no id the server resolves the widget under the point itself");

  await assert.rejects(
    () => client.clickRef("999"),
    (err) => {
      assert.equal(err.message, "inspector click failed: No object with id 999", "the failing command is named `click`");
      return true;
    },
  );
});

test("findByType asks for typeName, the key the server actually reads", T, async (t) => {
  // ../src/runner/open.ts does `findByType("SidebarPanel").catch(() => null)?.matches?.[0]`
  // and falls back quietly when there is no match, so the wrong key throws
  // nowhere at all: it just makes launching an app by its sidebar tile stop
  // working, in every app, with nothing in the report to point at.
  const byType = {
    SidebarPanel: [{ id: "5", type: "SidebarPanel_QMLTYPE_31", objectName: "sidebar" }],
  };
  const server = await fakeInspector(t, (req, sock) => {
    const matches = byType[req.params.typeName] ?? [];
    sock.write(ok(req, { matches, count: matches.length }));
  });
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2000 });
  t.after(() => client.disconnect());

  const found = await client.findByType("SidebarPanel");
  assert.deepEqual(server.requests[0], { id: 0, command: "findByType", params: { typeName: "SidebarPanel" } });
  assert.equal(found.count, 1);
  assert.equal(found.matches[0].id, "5");
  assert.equal(found.matches[0].objectName, "sidebar");

  const none = await client.findByType("NoSuchType");
  assert.deepEqual(none.matches, [], "a type nothing matches is an empty list, not an error");
  assert.deepEqual(server.requests[1].params, { typeName: "NoSuchType" });
});

test("setProperty sends the value with its own type, falsy values included", T, async (t) => {
  // Clearing a field is setProperty(id, "text", "") and it is the first thing
  // every `type:` action does. A wrapper that dropped falsy values would leave
  // the old contents in place for sendKeys to append to, so the app would be
  // handed the previous step's input with this step's stuck on the end — and
  // the step would still go green.
  const server = await fakeInspector(t, (req, sock) => {
    if (!("value" in req.params)) {
      sock.write(line({ error: "setProperty: value is required", id: req.id }));
      return;
    }
    sock.write(ok(req, { set: true, property: req.params.property }));
  });
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2000 });
  t.after(() => client.disconnect());

  const cleared = await client.setProperty("31", "text", "");
  await client.setProperty("31", "currentIndex", 0);
  await client.setProperty("31", "enabled", false);
  assert.deepEqual(
    server.requests.map((r) => [r.command, r.params]),
    [
      ["setProperty", { objectId: "31", property: "text", value: "" }],
      ["setProperty", { objectId: "31", property: "currentIndex", value: 0 }],
      ["setProperty", { objectId: "31", property: "enabled", value: false }],
    ],
  );
  assert.equal(typeof server.requests[1].params.value, "number", '0 must not arrive as "0" — the server assigns it to an int property');
  assert.equal(typeof server.requests[2].params.value, "boolean");
  assert.equal(cleared.property, "text", "the server's answer is handed back, not swallowed");
});

test("callMethod always sends an args array, empty when the caller gave none", T, async (t) => {
  // actions.ts invokes forceActiveFocus, accepted and nextItemInFocusChain with
  // no arguments at all. The server reads params["args"] as a list, so an
  // omitted key is not an empty list — it is a null variant and the invocation
  // is refused, which would break focusing a text field on every typed step.
  const server = await fakeInspector(t, (req, sock) => {
    if (!Array.isArray(req.params.args)) {
      sock.write(line({ error: "callMethod: args must be a list", id: req.id }));
      return;
    }
    sock.write(ok(req, { invoked: `${req.params.method}/${req.params.args.length}` }));
  });
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2000 });
  t.after(() => client.disconnect());

  const bare = await client.callMethod("7", "forceActiveFocus");
  assert.deepEqual(server.requests[0], {
    id: 0,
    command: "callMethod",
    params: { objectId: "7", method: "forceActiveFocus", args: [] },
  });
  assert.equal(bare.invoked, "forceActiveFocus/0");

  const withArgs = await client.callMethod("7", "setText", ["Отправить", 3]);
  assert.deepEqual(
    server.requests[1].params,
    { objectId: "7", method: "setText", args: ["Отправить", 3] },
    "the arguments go out in order and with their types, since the server maps them positionally",
  );
  assert.equal(withArgs.invoked, "setText/2");
});

test("sendKeys sends the text under `text` and hands back what the server says it typed", T, async (t) => {
  // The one command that blocks: the server uses sendEvent here, so its reply is
  // real evidence the characters were delivered — which is why the runner trusts
  // it and does not read the field back. A renamed or mangled parameter would
  // type nothing and still resolve, and the step would pass having entered
  // nothing at all.
  const server = await fakeInspector(t, (req, sock) => {
    if (typeof req.params.text !== "string") {
      sock.write(line({ error: "sendKeys: text is required", id: req.id }));
      return;
    }
    sock.write(ok(req, { sent: req.params.text, target: "QQuickTextField" }));
  });
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2000 });
  t.after(() => client.disconnect());

  const res = await client.sendKeys("Отправить 42");
  assert.deepEqual(server.requests[0], { id: 0, command: "sendKeys", params: { text: "Отправить 42" } });
  assert.equal(res.sent, "Отправить 42", "verbatim: the client filters nothing, the server's key mapping is the only limit");
  assert.equal(res.target, "QQuickTextField");
});

test("evaluate sends the expression as the expression and the object id as the object id", T, async (t) => {
  // THE defect on this side of the file. The two arguments went out reversed, so
  // `evaluate(expr, qmlRootId)` asked the app to evaluate "17" — the id — with
  // the real expression sitting in objectId. Nothing threw on the client: the
  // app answered a ReferenceError, and `state:` checks, the wallet unlock and
  // the debug REPL's `state` command all reported that as the user's expression
  // being wrong. The fake resolves the context id through a registry the way the
  // server does, so the reversal fails with "Object not found", exactly as it
  // failed in the field.
  const roots = { "17": { "root.total": 42, "JSON.stringify(this)": '{"total":42}' } };
  const server = await fakeInspector(t, (req, sock) => {
    const { expression, objectId } = req.params;
    const scope = objectId === undefined ? { "1 + 1": 2 } : roots[objectId];
    if (!scope) {
      sock.write(line({ error: `Object not found: ${objectId}`, id: req.id }));
      return;
    }
    if (!(expression in scope)) {
      sock.write(line({ error: `ReferenceError: ${expression} is not defined`, id: req.id }));
      return;
    }
    sock.write(ok(req, { result: scope[expression], undefined: false }));
  });
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 2000 });
  t.after(() => client.disconnect());

  const res = await client.evaluate("root.total", "17");
  assert.equal(server.requests[0].params.expression, "root.total", "the first argument is the expression");
  assert.equal(server.requests[0].params.objectId, "17", "the second is the context object — never the other way round");
  assert.deepEqual(server.requests[0], {
    id: 0,
    command: "evaluate",
    params: { expression: "root.total", objectId: "17" },
  });
  assert.equal(res.result, 42);
  assert.equal(res.undefined, false);

  const stringified = await client.evaluate("JSON.stringify(this)", "17");
  assert.equal(stringified.result, '{"total":42}', "the runner reads the app's state through exactly this call");

  const rootless = await client.evaluate("1 + 1");
  assert.deepEqual(
    server.requests[2].params,
    { expression: "1 + 1" },
    "with no context object the key is left off entirely rather than sent as null",
  );
  assert.equal(rootless.result, 2);
});

test("a connection reset is reported as a socket error with its errno, not as a clean exit", T, async (t) => {
  // An app that dies inside the command it is servicing resets the connection
  // rather than closing it: the socket emits `error` — carrying the errno — and
  // only then `close`. If that path did not tear the client down, the in-flight
  // command would sit until its deadline; if it were reported as the close
  // message instead, the reader would be told the app exited, `doctor` would
  // have no errno to print, and a crash would read as a tidy shutdown.
  const server = await fakeInspector(t, (_req, sock) => sock.resetAndDestroy());
  const client = new InspectorClient({ host: "127.0.0.1", port: server.port, timeoutMs: 30_000 });
  t.after(() => client.disconnect());

  const started = Date.now();
  await assert.rejects(
    () => client.screenshot("9"),
    (err) => {
      assert.ok(err instanceof InspectorTransportError);
      assert.equal(err.message, "inspector socket error: read ECONNRESET");
      assert.equal(err.cause?.code, "ECONNRESET", "the errno survives on the cause for doctor to print");
      return true;
    },
  );
  assert.ok(Date.now() - started < 3000, "it must fail on the reset, not on the 30s deadline");
  assert.equal(client.connected, false);
});
