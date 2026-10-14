// --interactive edit gate — between Phase 4 (compose) and Phase 5 (enhance)
// the composed .drawio is opened in the diagrams.net editor and the run
// pauses until a key is pressed in the terminal.
//
// Same technique as the stand-alone auto_drawio helper: a loopback HTTP
// server (127.0.0.1 only, never reachable from other machines) serves a small
// page (assets/editor.html) that hosts embed.diagrams.net in an iframe and
// speaks its JSON postMessage protocol. Every autosave is POSTed back and
// written atomically over figures/full_figure.drawio. Enter continues — the
// PNG is re-exported when the drawio changed, since Phase 5/6 only ever read
// full_figure.png — and Esc leaves the run with the deterministic figure.
//
// Layers (each depends only on the one above):
//   1. renderEditorPage    fills the page template's __PLACEHOLDERS__
//   2. startEditorServer   loopback server: GET / and /file, POST /save, /exit
//   3. waitForEnterOrEsc   raw-mode key wait (line mode when stdin is piped)
//      openInBrowser       best-effort `open` / `xdg-open` / `start`
//   4. runInteractiveEdit  the phase: serve, wait, re-export, report

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import type { PhaseResult, RunContext } from "./context.js";
import { PhaseError } from "./errors.js";
import { TeeLog } from "./exec.js";
import { exportDrawioPngRobust } from "./export-png.js";
import { elapsed, logDetail, logWarn, timerStart } from "./log.js";
import { toolkitDir } from "./paths.js";
import { DRAWIO_EXPORT_ATTEMPTS, DRAWIO_EXPORT_TIMEOUT_SECS, TARGET_WIDTH } from "./phase-compose.js";

// ── 1. Editor page ────────────────────────────────────────────────────────

export const EMBED_ORIGIN = "https://embed.diagrams.net";
export const EMBED_URL = `${EMBED_ORIGIN}/?embed=1&proto=json&spin=1&modified=unsavedChanges&libraries=1`;

export function editorPagePath(): string {
  return path.join(toolkitDir(), "assets", "editor.html");
}

// Fill the page template for one file. Autosave is always on; the page's
// export branch (used by auto_drawio's --png mode) stays disabled.
export function renderEditorPage(drawioPath: string, template: string = fs.readFileSync(editorPagePath(), "utf8")): string {
  const name = path.basename(drawioPath);
  const fills: Record<string, string> = {
    __TITLE__: `${name} – draw.io`,
    __TITLE_JSON__: JSON.stringify(name),
    __ORIGIN__: JSON.stringify(EMBED_ORIGIN),
    __EMBED_URL__: JSON.stringify(EMBED_URL),
    __AUTOSAVE__: "true",
    __EXPORT__: "null",
  };
  let page = template;
  // Function replacement: a JSON value may contain `$&`-style patterns that a
  // string replacement would expand.
  for (const [placeholder, value] of Object.entries(fills)) page = page.replaceAll(placeholder, () => value);
  return page;
}

// ── 2. Loopback server ────────────────────────────────────────────────────

export interface EditorServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface EditorServerOptions {
  drawioPath: string;
  port?: number; // 0 / undefined = any free port
  page?: string; // pre-rendered page (tests)
  onSave?: (bytes: number) => void;
  onExit?: () => void;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const CLOSE_CAP_MS = 5000;
const IN_FLIGHT_POLL_MS = 25;

// Temp file + rename so a crash never leaves a half-written figure.
function writeAtomic(target: string, data: string): void {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res: http.ServerResponse, status: number, body: string | Buffer, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

export function startEditorServer(opts: EditorServerOptions): Promise<EditorServer> {
  const page = opts.page ?? renderEditorPage(opts.drawioPath);
  let inFlight = 0; // requests being handled right now (a save mid-upload must not be cut)

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = req.url ?? "/";
    if (req.method === "GET") {
      if (url === "/") return reply(res, 200, page, "text/html; charset=utf-8");
      if (url === "/file") return reply(res, 200, fs.readFileSync(opts.drawioPath), "application/xml; charset=utf-8");
      return reply(res, 404, "not found");
    }
    if (req.method !== "POST") return reply(res, 404, "not found");
    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      return reply(res, 413, err instanceof Error ? err.message : String(err));
    }
    if (url === "/save") {
      if (!body.trimStart().startsWith("<")) return reply(res, 400, "refusing to write: payload is not XML");
      try {
        writeAtomic(opts.drawioPath, body);
      } catch (err) {
        return reply(res, 500, err instanceof Error ? err.message : String(err));
      }
      opts.onSave?.(Buffer.byteLength(body));
      return reply(res, 200, "ok");
    }
    if (url === "/exit") {
      reply(res, 200, "bye");
      opts.onExit?.();
      return;
    }
    return reply(res, 404, "not found");
  };

  const server = http.createServer((req, res) => {
    // Held until the response has been handed to the OS ('finish'), or the
    // connection died ('close'), so a close() cannot cut a reply still in
    // Node's write queue.
    inFlight++;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      inFlight--;
    };
    res.once("finish", release);
    res.once("close", release);
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) reply(res, 500, err instanceof Error ? err.message : String(err));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        port,
        // close() lets an in-flight request (a last autosave) finish, then
        // cuts every connection: browsers keep spare connections open that
        // never carry a request, and waiting for those would only end at
        // the cap, which stays as the safety net for a stuck client.
        close: () =>
          new Promise<void>((done) => {
            let closed = false;
            const cap = setTimeout(() => server.closeAllConnections(), CLOSE_CAP_MS);
            cap.unref();
            const cutWhenIdle = (): void => {
              if (closed) return;
              if (inFlight === 0) server.closeAllConnections();
              else setTimeout(cutWhenIdle, IN_FLIGHT_POLL_MS).unref();
            };
            server.close(() => {
              closed = true;
              clearTimeout(cap);
              done();
            });
            cutWhenIdle();
          }),
      });
    });
  });
}

// ── 3a. Key wait ──────────────────────────────────────────────────────────

export type EditDecision = "continue" | "leave";

export interface KeyStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

// Arrow / function keys arrive as Esc followed by more bytes; a lone Esc that
// stays alone for this long is the Esc key itself.
const ESCAPE_SEQUENCE_GRACE_MS = 50;
// Keys pressed during the long phases before this one sit in the terminal's
// input queue (nothing read stdin, and switching to raw mode does not flush
// it) and would arrive as the very first chunk. Discard whatever shows up
// this soon after the wait starts: only a key pressed at the prompt counts.
const STALE_INPUT_DRAIN_MS = 150;

// Block until a key is pressed. Enter → "continue"; Esc or Ctrl+D (or end of
// a piped stdin) → "leave". On a TTY the terminal is switched to raw mode for
// the wait and always restored. Raw mode turns Ctrl+C into a plain byte, so it
// is handed to `onInterrupt` (default: re-raise SIGINT, which the pipeline's
// interrupt handler turns into the usual teardown + exit 130) and the promise
// stays pending while that runs. Piped stdin: any line continues, EOF leaves.
export function waitForEnterOrEsc(
  stdin: KeyStream = process.stdin,
  opts: { onInterrupt?: () => void; drainMs?: number } = {},
): Promise<EditDecision> {
  const raw = Boolean(stdin.isTTY && typeof stdin.setRawMode === "function");
  const onInterrupt = opts.onInterrupt ?? (() => process.kill(process.pid, "SIGINT"));
  const drainMs = opts.drainMs ?? STALE_INPUT_DRAIN_MS;
  return new Promise((resolve) => {
    let escTimer: NodeJS.Timeout | undefined;
    let armed = !raw; // a TTY starts by draining queued input; piped stdin is read as-is
    const armTimer = raw ? setTimeout(() => (armed = true), drainMs) : undefined;
    const finish = (decision: EditDecision | null): void => {
      clearTimeout(escTimer);
      clearTimeout(armTimer);
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onEnd);
      if (raw) stdin.setRawMode!(false);
      stdin.pause();
      if (decision) resolve(decision);
      else onInterrupt();
    };
    const onEnd = (): void => finish("leave");
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.from(chunk);
      if (!raw) {
        if (bytes.includes(0x0a) || bytes.includes(0x0d)) finish("continue");
        return;
      }
      if (bytes.includes(0x03)) return finish(null); // Ctrl+C — honoured even while draining
      if (!armed) return; // stale input from before the prompt
      if (escTimer) {
        // The tail of an Esc-prefixed key sequence: swallow it.
        clearTimeout(escTimer);
        escTimer = undefined;
        return;
      }
      if (bytes[0] === 0x1b) {
        if (bytes.length > 1) return; // a whole escape sequence in one chunk
        escTimer = setTimeout(() => finish("leave"), ESCAPE_SEQUENCE_GRACE_MS);
        return;
      }
      if (bytes.includes(0x0d) || bytes.includes(0x0a)) return finish("continue");
      if (bytes.includes(0x04)) return finish("leave"); // Ctrl+D
    };
    if (raw) stdin.setRawMode!(true);
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onEnd);
    stdin.resume();
  });
}

// ── 3b. Browser ───────────────────────────────────────────────────────────

// The platform's URL opener, or null on a headless Linux box (no DISPLAY /
// WAYLAND_DISPLAY), where there is no GUI browser to open.
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] | null {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return ["xdg-open", url];
  return null;
}

// Best-effort: returns whether an opener was launched (not whether a browser
// actually appeared — the URL is always printed for the user regardless).
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  const cmd = browserCommand(url, platform, env);
  if (!cmd) return false;
  try {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true });
    child.on("error", (err) => logWarn("edit", `could not open a browser (${err.message}) — open ${url} yourself`));
    child.unref();
    return true;
  } catch (err) {
    logWarn("edit", `could not open a browser (${err instanceof Error ? err.message : String(err)}) — open ${url} yourself`);
    return false;
  }
}

// ── 4. The phase ──────────────────────────────────────────────────────────

// Overridable pieces of the gate — the stubbed pipeline tests drive both
// branches without a tty or a browser.
export interface InteractiveHooks {
  waitForKey: () => Promise<EditDecision>;
  openBrowser: (url: string) => boolean;
  autosaveGraceMs: number; // a debounced autosave may still be in flight after the key press
}

export interface InteractiveEditOptions {
  port?: number;
  nextStep: string; // what Enter does: "continue to the enhance phase" / "finish the run"
  hooks?: Partial<InteractiveHooks>;
}

export interface InteractiveEditResult extends PhaseResult {
  decision: EditDecision;
}

const AUTOSAVE_GRACE_MS = 1500;

function fileDigest(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export async function runInteractiveEdit(ctx: RunContext, opts: InteractiveEditOptions): Promise<InteractiveEditResult> {
  const start = timerStart();
  const figs = path.join(ctx.workdir, "figures");
  const drawioPath = path.join(figs, "full_figure.drawio");
  const pngOut = path.join(figs, "full_figure.png");
  const tee = new TeeLog(path.join(ctx.workdir, "logs", "phase4b.log"));
  const hooks: InteractiveHooks = {
    waitForKey: () => waitForEnterOrEsc(),
    openBrowser: openInBrowser,
    autosaveGraceMs: AUTOSAVE_GRACE_MS,
    ...opts.hooks,
  };

  try {
    if (!fs.existsSync(drawioPath)) {
      tee.err("edit", `${drawioPath} missing — run phase 4 first`);
      throw new PhaseError(`${drawioPath} missing — run phase 4 first`, 1, tee.logPath);
    }
    const before = fileDigest(drawioPath);
    let saves = 0;

    let server: EditorServer;
    try {
      server = await startEditorServer({
        drawioPath,
        port: opts.port,
        onSave: (bytes) => {
          saves++;
          tee.info("edit", `saved ${drawioPath} (${bytes} bytes)`);
        },
        onExit: () => tee.info("edit", "editor closed in the browser"),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tee.err("edit", `cannot listen on 127.0.0.1:${opts.port ?? 0}: ${msg}`);
      throw new PhaseError(`cannot listen on 127.0.0.1:${opts.port ?? 0}: ${msg}`, 1, tee.logPath);
    }
    tee.info("edit", `editor served at ${server.url}`);

    const opened = hooks.openBrowser(server.url);
    logDetail(`Edit the figure at ${server.url} — every change autosaves into ${path.relative(ctx.workdir, drawioPath)}`);
    if (!opened) logDetail(`No browser here? Forward the port from your own computer first: ssh -L ${server.port}:127.0.0.1:${server.port} <user>@<remote-host>`);
    logDetail(`Press Enter to ${opts.nextStep}, or Esc to leave.`);

    let decision: EditDecision;
    try {
      decision = await hooks.waitForKey();
      if (hooks.autosaveGraceMs > 0) await new Promise((r) => setTimeout(r, hooks.autosaveGraceMs));
    } finally {
      await server.close();
    }
    tee.info("edit", `${decision === "continue" ? "Enter" : "Esc"} pressed after ${saves} save(s); server stopped`);

    const edited = fileDigest(drawioPath) !== before;
    if (edited) {
      tee.info("edit", `${drawioPath} changed — re-exporting ${pngOut} (width=${TARGET_WIDTH})`);
      await exportDrawioPngRobust({
        drawioPath,
        pngOut,
        widthPx: TARGET_WIDTH,
        tee,
        env: ctx.env,
        directAttempts: DRAWIO_EXPORT_ATTEMPTS,
        directTimeoutSecs: DRAWIO_EXPORT_TIMEOUT_SECS,
      });
      tee.done("edit", `re-exported ${pngOut} ${elapsed(start)}`);
    } else {
      tee.info("edit", `${drawioPath} unchanged — keeping the Phase 4 export ${elapsed(start)}`);
    }

    const what = edited ? `edited · ${saves} save${saves === 1 ? "" : "s"} · PNG re-exported` : "unchanged";
    return { status: "completed", outcome: `${what} · ${decision === "continue" ? "continuing" : "leaving"}`, decision };
  } finally {
    await tee.close();
  }
}
