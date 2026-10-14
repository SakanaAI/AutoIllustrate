import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import {
  EMBED_ORIGIN,
  browserCommand,
  editorPagePath,
  renderEditorPage,
  startEditorServer,
  waitForEnterOrEsc,
  type KeyStream,
} from "../src/interactive.js";

const XML = '<mxfile><diagram name="Page-1"><mxGraphModel/></diagram></mxfile>';

function tmpDrawio(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoillustrate-edit-"));
  const file = path.join(dir, "full_figure.drawio");
  fs.writeFileSync(file, XML);
  return file;
}

// ── page ──────────────────────────────────────────────────────────────────

test("editor page ships with the package and every placeholder is filled", () => {
  assert.ok(fs.existsSync(editorPagePath()), "assets/editor.html present");
  const page = renderEditorPage("/runs/x/figures/full_figure.drawio");
  assert.doesNotMatch(page, /__[A-Z_]+__/, "no unfilled __PLACEHOLDER__ left");
  assert.match(page, /<title>full_figure\.drawio – draw\.io<\/title>/);
  assert.ok(page.includes(`const ORIGIN = ${JSON.stringify(EMBED_ORIGIN)};`));
  assert.ok(page.includes("const AUTOSAVE = true;"));
  assert.ok(page.includes("const EXPORT = null;"));
});

test("renderEditorPage does not expand $-patterns from the file name", () => {
  const page = renderEditorPage("/x/$&.drawio", "T=__TITLE_JSON__");
  assert.equal(page, 'T="$&.drawio"');
});

// ── server ────────────────────────────────────────────────────────────────

test("editor server serves the page and the file, writes saves atomically, refuses non-XML", async () => {
  const file = tmpDrawio();
  const saves: number[] = [];
  let exited = false;
  const server = await startEditorServer({ drawioPath: file, page: "<html>page</html>", onSave: (n) => saves.push(n), onExit: () => (exited = true) });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(server.port > 0, true);

    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await page.text(), "<html>page</html>");

    const current = await fetch(`${server.url}file`);
    assert.equal(current.status, 200);
    assert.equal(await current.text(), XML);

    const bad = await fetch(`${server.url}save`, { method: "POST", body: "not xml at all" });
    assert.equal(bad.status, 400);
    assert.equal(fs.readFileSync(file, "utf8"), XML, "file untouched by a rejected save");

    const edited = XML.replace("Page-1", "Edited");
    const ok = await fetch(`${server.url}save`, { method: "POST", body: `\n  ${edited}` });
    assert.equal(ok.status, 200);
    assert.equal(fs.readFileSync(file, "utf8"), `\n  ${edited}`);
    assert.ok(!fs.existsSync(`${file}.tmp`), "temp file renamed away");
    assert.deepEqual(saves, [Buffer.byteLength(`\n  ${edited}`)]);

    assert.equal((await fetch(`${server.url}nope`)).status, 404);
    assert.equal((await fetch(`${server.url}export`, { method: "POST", body: "x" })).status, 404);

    const bye = await fetch(`${server.url}exit`, { method: "POST", body: "" });
    assert.equal(bye.status, 200);
    assert.equal(exited, true);
  } finally {
    await server.close();
  }
  await assert.rejects(fetch(`${server.url}file`), "server no longer listening after close()");
});

test("editor server close() does not wait for a browser's spare idle connection", async () => {
  const server = await startEditorServer({ drawioPath: tmpDrawio(), page: "p" });
  // Browsers open connections ahead of time and never send a request on them.
  const spare = net.connect(server.port, "127.0.0.1");
  await new Promise((r) => spare.once("connect", r));
  const t0 = Date.now();
  await server.close();
  assert.ok(Date.now() - t0 < 1000, `close() took ${Date.now() - t0}ms — must not run to the cap`);
  spare.destroy();
});

test("editor server close() lets a save that is mid-upload finish first", async () => {
  const file = tmpDrawio();
  const saves: number[] = [];
  const server = await startEditorServer({ drawioPath: file, page: "p", onSave: (n) => saves.push(n) });
  const body = XML.replace("Page-1", "Slow");
  const head = body.slice(0, 10);
  const tail = body.slice(10);
  const socket = net.connect(server.port, "127.0.0.1");
  await new Promise((r) => socket.once("connect", r));
  let response = "";
  socket.on("data", (chunk) => (response += chunk.toString()));
  socket.write(`POST /save HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${head}`);
  await new Promise((r) => setTimeout(r, 50)); // request is now in flight, body incomplete
  let closed = false;
  const closing = server.close().then(() => (closed = true));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(closed, false, "close() waits while the upload is in flight");
  socket.write(tail);
  await closing;
  // The server cuts the connection once the reply is flushed; wait for that
  // end-of-stream on the client before reading what arrived.
  await new Promise((r) => socket.once("close", r));
  assert.match(response, /^HTTP\/1\.1 200/);
  assert.equal(fs.readFileSync(file, "utf8"), body, "the slow save landed intact");
  assert.deepEqual(saves, [Buffer.byteLength(body)]);
});

test("editor server honours a fixed port and rejects one already in use", async () => {
  const file = tmpDrawio();
  const first = await startEditorServer({ drawioPath: file, page: "p" });
  try {
    const second = await startEditorServer({ drawioPath: file, page: "p", port: first.port }).then(
      (s) => s.close().then(() => "listened"),
      (err: NodeJS.ErrnoException) => err.code,
    );
    assert.equal(second, "EADDRINUSE");
  } finally {
    await first.close();
  }
});

// ── key wait ──────────────────────────────────────────────────────────────

interface FakeTty extends KeyStream {
  rawMode: boolean[];
}

function fakeTty(): FakeTty {
  const stream = new PassThrough() as unknown as FakeTty;
  stream.isTTY = true;
  stream.rawMode = [];
  stream.setRawMode = (mode: boolean) => {
    stream.rawMode.push(mode);
    return stream;
  };
  return stream;
}

// A TTY wait first drains input queued before the prompt; tests use a short
// window and write only once it has passed.
const DRAIN_MS = 20;
const armed = (): Promise<void> => new Promise((r) => setTimeout(r, DRAIN_MS + 15));
const wait = (tty: KeyStream, onInterrupt?: () => void) => waitForEnterOrEsc(tty, { drainMs: DRAIN_MS, onInterrupt });

test("tty: Enter continues, raw mode switched on for the wait and back off", async () => {
  const tty = fakeTty();
  const pending = wait(tty);
  await armed();
  (tty as unknown as PassThrough).write("\r");
  assert.equal(await pending, "continue");
  assert.deepEqual(tty.rawMode, [true, false]);
});

test("tty: input queued before the prompt is discarded, a later Enter counts", async () => {
  const tty = fakeTty();
  const pending = wait(tty);
  (tty as unknown as PassThrough).write("\n"); // an Enter pressed an hour ago, still in the tty queue
  (tty as unknown as PassThrough).write("\x1b");
  let settled = false;
  void pending.then(() => (settled = true));
  await armed();
  assert.equal(settled, false, "stale bytes did not answer the prompt");
  (tty as unknown as PassThrough).write("\r");
  assert.equal(await pending, "continue");
});

test("tty: a lone Esc leaves, an arrow key is ignored, Ctrl+D leaves", async () => {
  const esc = fakeTty();
  const escWait = wait(esc);
  await armed();
  (esc as unknown as PassThrough).write("\x1b");
  assert.equal(await escWait, "leave");

  const arrow = fakeTty();
  const arrowWait = wait(arrow);
  await armed();
  (arrow as unknown as PassThrough).write("\x1b[A"); // up arrow, one chunk
  (arrow as unknown as PassThrough).write("\x1b"); // Esc …
  (arrow as unknown as PassThrough).write("[B"); // … turns out to be a split down arrow
  (arrow as unknown as PassThrough).write("\n");
  assert.equal(await arrowWait, "continue");

  const eof = fakeTty();
  const eofWait = wait(eof);
  await armed();
  (eof as unknown as PassThrough).write("\x04");
  assert.equal(await eofWait, "leave");
});

test("tty: Ctrl+C restores the terminal and hands over to the interrupt handler, even while draining", async () => {
  const tty = fakeTty();
  let interrupted = 0;
  let settled = false;
  const pending = wait(tty, () => interrupted++).then(() => (settled = true));
  (tty as unknown as PassThrough).write("\x03"); // before the drain window has passed
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(interrupted, 1);
  assert.deepEqual(tty.rawMode, [true, false], "raw mode restored before the handler runs");
  assert.equal(settled, false, "the wait stays pending while teardown runs");
  void pending;
});

test("piped stdin: a line continues, end of input leaves, raw mode never touched", async () => {
  const line = new PassThrough();
  const lineWait = waitForEnterOrEsc(line);
  line.write("anything\n");
  assert.equal(await lineWait, "continue");

  const eof = new PassThrough();
  const eofWait = waitForEnterOrEsc(eof);
  eof.end();
  assert.equal(await eofWait, "leave");
});

// ── browser ───────────────────────────────────────────────────────────────

test("browserCommand picks the platform opener and skips headless Linux", () => {
  const url = "http://127.0.0.1:1234/";
  assert.deepEqual(browserCommand(url, "darwin", {}), ["open", url]);
  assert.deepEqual(browserCommand(url, "win32", {}), ["cmd", "/c", "start", "", url]);
  assert.deepEqual(browserCommand(url, "linux", { DISPLAY: ":0" }), ["xdg-open", url]);
  assert.deepEqual(browserCommand(url, "linux", { WAYLAND_DISPLAY: "wayland-0" }), ["xdg-open", url]);
  assert.equal(browserCommand(url, "linux", {}), null);
});
