// The two ways a log line can reach a run, and the arithmetic that decides
// whether it arrives intact.
//
// The shipped defect pinned here is the chunk boundary one: the stdout pump
// decoded each read on its own with `chunk.toString("utf8")`, so a multi-byte
// character straddling a boundary became two replacement characters and a
// `console:` expectation naming that line FAILED for text the app had really
// logged — deterministic per payload, so it read as a genuine failure
// (openspec/changes/archive/2026-08-17-stream-utf8-decoding). Reverting the
// StringDecoder in pumpLines back to chunk.toString() makes the split-chunk
// test below fail on every one of its boundaries.
//
// The attach path — listSessionLogs, newestSessionChain and FileTailSource, the
// only log source behind `--attach --logs-dir` — had no test at all. Its
// correctness argument, and the reason the change above declared it a non-goal,
// is that it advances by BYTE length past the last complete newline. Advance by
// character count instead and the next poll resumes mid-character and delivers
// the tail of a line it has already delivered.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { ChildStdoutSource, FileTailSource, listSessionLogs, newestSessionChain } from "../dist/logs/source.js";
import { LogBuffer } from "../dist/logs/buffer.js";

const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sito-logsource-"));
const texts = (buffer) => buffer.slice(0).map((l) => l.text);
const flush = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Copied verbatim from ~/.local/share/Logos/LogosBasecampDev/logs. The
// non-ASCII lines further down are invented — nothing in that corpus logs
// Cyrillic — but only their byte lengths matter, and those are real UTF-8.
const STARTED = "Logos Core started successfully!";
const CALL = 'LogosAPIClient: invoking remote method "medusa_core" "getWalletState" args_count: 0';
const TRANSPORT = '[LogosObject] RemoteLogosObject::callMethod "getWalletState" args: 0';

// --- which files are a session, and in what order ----------------------------

test("the rotation chain is newest session first, and each session in rotation order", (t) => {
  const dir = mkTmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Two sessions of a rotating log, plus the debris a real logs dir collects.
  for (const name of [
    "basecamp_20260818_093012.001.log",
    "basecamp_20260817_221049.log",
    "basecamp_20260818_093012.log",
    "basecamp_20260817_221049.001.log",
    "basecamp_20260818_093012.002.log",
    "basecamp_20260818_093012.log.bak",
    "basecamp_20260818_093012.001.log.gz",
    "basecamp.log",
    "ui-host_20260818_093012.log",
    "basecamp_2026818_093012.log",
  ]) {
    fs.writeFileSync(path.join(dir, name), STARTED + "\n");
  }
  // Nested logs are somebody's own housekeeping, and are not this session.
  fs.mkdirSync(path.join(dir, "archive"));
  fs.writeFileSync(path.join(dir, "archive", "basecamp_20260819_101010.log"), STARTED + "\n");

  assert.deepEqual(
    listSessionLogs(dir).map((f) => f.file),
    [
      path.join(dir, "basecamp_20260818_093012.log"),
      path.join(dir, "basecamp_20260818_093012.001.log"),
      path.join(dir, "basecamp_20260818_093012.002.log"),
      path.join(dir, "basecamp_20260817_221049.log"),
      path.join(dir, "basecamp_20260817_221049.001.log"),
    ],
    "newest stamp first, rotation ascending inside a stamp, and nothing that is not a basecamp log",
  );

  const chain = newestSessionChain(dir);
  assert.deepEqual(
    chain.map((f) => f.file),
    [
      path.join(dir, "basecamp_20260818_093012.log"),
      path.join(dir, "basecamp_20260818_093012.001.log"),
      path.join(dir, "basecamp_20260818_093012.002.log"),
    ],
    "only the newest session, oldest part first — the tail reads them in this order",
  );
  assert.deepEqual(chain.map((f) => f.index), [0, 1, 2], "the unsuffixed file is part 0, not NaN");
  assert.deepEqual(new Set(chain.map((f) => f.stamp)), new Set(["20260818_093012"]));
});

test("the newest session is the newest stamp in the name, not the newest mtime", (t) => {
  const dir = mkTmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const older = path.join(dir, "basecamp_20260817_221049.log");
  const newer = path.join(dir, "basecamp_20260818_093012.log");
  fs.writeFileSync(older, STARTED + "\n");
  fs.writeFileSync(newer, STARTED + "\n");
  // A copy, a restore or an rsync of yesterday's logs makes it the most
  // recently written file on disk; it is still yesterday's session.
  const soon = new Date(Date.now() + 60_000);
  fs.utimesSync(older, soon, soon);

  assert.deepEqual(newestSessionChain(dir).map((f) => f.file), [newer]);
});

test("a logs dir that does not exist, or holds nothing we recognise, yields no chain", (t) => {
  const dir = mkTmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "README"), "not a log\n");

  assert.deepEqual(listSessionLogs(path.join(dir, "no", "such", "dir")), [], "a bad --logs-dir must not throw");
  assert.deepEqual(newestSessionChain(path.join(dir, "no", "such", "dir")), []);
  assert.deepEqual(listSessionLogs(dir), []);
  assert.deepEqual(newestSessionChain(dir), []);
});

// --- tailing the newest session ---------------------------------------------

test("a file tail delivers what is appended after it starts, and nothing that was there before", async (t) => {
  const dir = mkTmp();
  const file = path.join(dir, "basecamp_20260818_093012.log");
  fs.writeFileSync(file, STARTED + "\n");

  const buffer = new LogBuffer();
  const source = new FileTailSource(dir, buffer, { intervalMs: 10 });
  t.after(() => {
    source.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  fs.appendFileSync(file, CALL + "\n" + TRANSPORT + "\n");
  await buffer.waitFor((l) => l.text === TRANSPORT, { timeoutMs: 5000 });

  assert.deepEqual(texts(buffer), [CALL, TRANSPORT], "attach mode starts at end of file: the startup line is history");
  assert.deepEqual([...new Set(buffer.slice(0).map((l) => l.origin))], ["file"], "tailed lines are tagged as file, which is what downgrades the verdict");

  // fromStart is the opposite bargain, and has to actually replay.
  const replayed = new LogBuffer();
  const replay = new FileTailSource(dir, replayed, { intervalMs: 10, fromStart: true });
  t.after(() => replay.stop());
  await replayed.waitFor((l) => l.text === TRANSPORT, { timeoutMs: 5000 });
  assert.deepEqual(texts(replayed), [STARTED, CALL, TRANSPORT]);
});

test("a partial trailing line waits for its newline, and is not delivered twice when the rest arrives", async (t) => {
  const dir = mkTmp();
  const file = path.join(dir, "basecamp_20260818_093012.log");
  fs.writeFileSync(file, STARTED + "\n");

  const buffer = new LogBuffer();
  const source = new FileTailSource(dir, buffer, { intervalMs: 10 });
  t.after(() => {
    source.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Non-ASCII on purpose. QFile flushes mid-line, so a poll routinely sees a
  // complete line followed by half of the next one. If the offset advanced by
  // `lastNl + 1` characters instead of the byte length of that slice, the next
  // read would resume inside "Кошелёк" and hand the buffer a mangled duplicate
  // of a line it has already delivered.
  const first = "qml: Кошелёк готов";
  const second = "qml: баланс обновлён";
  fs.appendFileSync(file, first + "\n" + second.slice(0, 10));

  await buffer.waitFor((l) => l.text === first, { timeoutMs: 5000 });
  await sleep(60); // several polls, all of which must see an incomplete line
  assert.deepEqual(texts(buffer), [first], "half a line is not a line");

  fs.appendFileSync(file, second.slice(10) + "\n");
  await buffer.waitFor((l) => l.text === second, { timeoutMs: 5000 });
  await sleep(60);
  assert.deepEqual(texts(buffer), [first, second], "exactly two lines, neither of them repeated or mangled");
});

test("a rotation file that appears mid-session is picked up after the one it follows", async (t) => {
  const dir = mkTmp();
  const base = path.join(dir, "basecamp_20260818_093012.log");
  fs.writeFileSync(base, "");

  const buffer = new LogBuffer();
  const source = new FileTailSource(dir, buffer, { intervalMs: 10 });
  t.after(() => {
    source.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  fs.appendFileSync(base, CALL + "\n");
  await buffer.waitFor((l) => l.text === CALL, { timeoutMs: 5000 });

  // Basecamp rotates every 10 000 lines; the run outlives the file it started on.
  fs.writeFileSync(path.join(dir, "basecamp_20260818_093012.001.log"), TRANSPORT + "\n");
  await buffer.waitFor((l) => l.text === TRANSPORT, { timeoutMs: 5000 });
  assert.deepEqual(texts(buffer), [CALL, TRANSPORT]);
});

test("once the app restarts under us, only the new session is tailed", async (t) => {
  const dir = mkTmp();
  const first = path.join(dir, "basecamp_20260818_093012.log");
  fs.writeFileSync(first, "");

  const buffer = new LogBuffer();
  const source = new FileTailSource(dir, buffer, { intervalMs: 10 });
  t.after(() => {
    source.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  fs.appendFileSync(first, CALL + "\n");
  await buffer.waitFor((l) => l.text === CALL, { timeoutMs: 5000 });

  fs.writeFileSync(path.join(dir, "basecamp_20260818_094500.log"), STARTED + "\n");
  fs.appendFileSync(first, TRANSPORT + "\n");
  await buffer.waitFor((l) => l.text === STARTED, { timeoutMs: 5000 });
  await sleep(60);

  assert.deepEqual(
    texts(buffer),
    [CALL, STARTED],
    "a dead session's leftovers must not be correlated with the live one's clicks",
  );
});

test("a stopped file tail delivers nothing further, whatever the app writes next", async (t) => {
  const dir = mkTmp();
  const file = path.join(dir, "basecamp_20260818_093012.log");
  fs.writeFileSync(file, "");

  const buffer = new LogBuffer();
  const source = new FileTailSource(dir, buffer, { intervalMs: 10 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.appendFileSync(file, CALL + "\n");
  await buffer.waitFor((l) => l.text === CALL, { timeoutMs: 5000 });

  // attach() calls logs.close() straight after source.stop(); a line arriving
  // after that is evidence attributed to a run that has already reported, so
  // the timer has to be gone rather than merely idle. (The "one last drain"
  // inside stop() is dead code — it sets `stopped` before calling poll(), which
  // returns on that flag — so anything not yet polled is lost. That is a real
  // gap, and this test deliberately does not pretend otherwise.)
  source.stop();
  fs.appendFileSync(file, TRANSPORT + "\n");
  await sleep(80);

  assert.deepEqual(texts(buffer), [CALL]);
});

// --- the owned run's stdout --------------------------------------------------

test("a multi-byte character split across two stdout chunks arrives as one intact line", async () => {
  // The bug: chunk.toString("utf8") per read. A pipe splits wherever the kernel
  // filled the buffer, so "Кошелёк" logged by a Russian app became
  // "Кошел��к" and `console: "qml: Кошелёк готов"` failed on a line
  // the app had emitted verbatim.
  for (const line of [
    "qml: Кошелёк готов",
    "qml: 残高を更新しました",
    "qml: 名前を「𠮷田」に更新しました", // 4-byte kanji, i.e. a surrogate pair
  ]) {
    const bytes = Buffer.from(line + "\n", "utf8");
    const splits = [];
    for (let i = 1; i < bytes.length; i++) if ((bytes[i] & 0xc0) === 0x80) splits.push(i);
    assert.ok(splits.length > 0, `${line} has no multi-byte character to split`);

    for (const at of splits) {
      const buffer = new LogBuffer();
      const stdout = new PassThrough();
      const source = new ChildStdoutSource(buffer, { stdout });

      // Prove the halves really do arrive as two reads; if the stream coalesced
      // them the decoder would never be asked the question this test asks.
      const seen = [];
      stdout.on("data", (c) => seen.push(c));
      stdout.write(bytes.subarray(0, at));
      await flush();
      stdout.write(bytes.subarray(at));
      await flush();
      assert.equal(seen.length, 2, `split at ${at} was not delivered as two chunks`);

      assert.deepEqual(texts(buffer), [line], `split at byte ${at}`);
      assert.equal(buffer.slice(0)[0].origin, "stdout");
      source.stop();
    }
  }
});

test("the early stderr window is pumped too, and stays distinguishable from stdout", async (t) => {
  const buffer = new LogBuffer();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const source = new ChildStdoutSource(buffer, { stdout, stderr });
  t.after(() => source.stop());

  // Everything before LogRedirector installs itself goes to the real stderr,
  // and that window is where a fatal launch failure is explained.
  stderr.write(Buffer.from('qt.qpa.plugin: Could not load the Qt platform plugin "xcb"\n', "utf8"));
  await flush();
  stdout.write(Buffer.from(CALL + "\n", "utf8"));
  await flush();

  assert.deepEqual(
    buffer.slice(0).map((l) => [l.origin, l.text]),
    [
      ["stderr", 'qt.qpa.plugin: Could not load the Qt platform plugin "xcb"'],
      ["stdout", CALL],
    ],
  );
});

test("a ui-host envelope on stdout becomes its individual lines, not one unmatchable blob", async (t) => {
  const buffer = new LogBuffer();
  const stdout = new PassThrough();
  const source = new ChildStdoutSource(buffer, { stdout });
  t.after(() => source.stop());

  stdout.write(
    Buffer.from(
      'ui-host [ "logos_wallet" ]: "ui-host: loaded plugin \\"logos_wallet\\"\\n' + CALL.replace(/"/g, '\\"') + '"\n',
      "utf8",
    ),
  );
  await flush();

  assert.deepEqual(texts(buffer), ['ui-host: loaded plugin "logos_wallet"', CALL], "the call inside the envelope has to be matchable on its own");
  assert.deepEqual(buffer.slice(0).map((l) => l.viaUiHost), ["logos_wallet", "logos_wallet"]);
});

test("stopping a child source flushes the trailing partial line and then stops listening", async (t) => {
  const buffer = new LogBuffer();
  const stdout = new PassThrough();
  const source = new ChildStdoutSource(buffer, { stdout });
  t.after(() => source.stop());

  // A crashing app's last line often has no newline; it is also the one that
  // says why it crashed, so it must not be dropped on shutdown.
  stdout.write(Buffer.from("qml: fatal: モジュールが応答しません", "utf8"));
  await flush();
  assert.deepEqual(texts(buffer), [], "still incomplete while the source is running");

  source.stop();
  assert.deepEqual(texts(buffer), ["qml: fatal: モジュールが応答しません"]);

  stdout.write(Buffer.from(CALL + "\n", "utf8"));
  await flush();
  assert.deepEqual(texts(buffer), ["qml: fatal: モジュールが応答しません"], "a stopped source is detached from the stream");
});
