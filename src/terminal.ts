// Dependency-free semantic terminal styling — the palette, colour gating, and
// text helpers every human-facing line goes through. Mirrors the conventions
// of agentic-scientist's terminal_ui: a small semantic palette (never raw
// colours at call sites), colours only on an interactive terminal unless
// FORCE_COLOR says otherwise, NO_COLOR / TERM=dumb always win, and untrusted
// text (agent output, paths, report fields) is escaped before it reaches the
// terminal so a stray control sequence cannot repaint the screen.

import { execFileSync } from "node:child_process";
import type { WriteStream } from "node:tty";

export type Semantic = "phase" | "running" | "success" | "failure" | "warning" | "detail" | "score";

const ESC = "\u001b";
const RESET = `${ESC}[0m`;
const STYLES: Record<Semantic, string> = {
  phase: `${ESC}[1;36m`,
  running: `${ESC}[33m`,
  success: `${ESC}[32m`,
  failure: `${ESC}[31m`,
  warning: `${ESC}[33m`,
  detail: `${ESC}[2m`,
  score: `${ESC}[36m`,
};

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface StreamLike {
  isTTY?: boolean;
  columns?: number;
}

// Whether semantic ANSI styles should be written to `stream`.
export function colorsEnabled(stream: StreamLike | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined || env.TERM === "dumb") return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  return Boolean(stream?.isTTY);
}

// Apply one semantic style without changing the underlying text.
export function style(text: string, semantic: Semantic, enabled: boolean): string {
  if (!enabled || !text) return text;
  return `${STYLES[semantic]}${text}${RESET}`;
}

// 256-colour foreground (used by the wordmark gradient).
export function paint256(text: string, color: number): string {
  return `${ESC}[38;5;${color}m${text}${RESET}`;
}

// 24-bit foreground, for terminals that advertise it (COLORTERM).
export function paintRgb(text: string, [r, g, b]: [number, number, number]): string {
  return `${ESC}[38;2;${r};${g};${b}m${text}${RESET}`;
}

// Terminal emulators known to render 24-bit colour, by TERM_PROGRAM.
const TRUE_COLOR_PROGRAMS = new Set(["iterm.app", "wezterm", "vscode", "ghostty", "hyper", "tabby", "kitty", "alacritty", "warpterminal", "rio", "contour"]);

// Inside tmux the outer terminal's COLORTERM is not visible, but tmux only
// passes 24-bit colour through when its own terminal has the RGB (or legacy
// Tc) feature, so ask it: the per-client feature list (tmux ≥ 3.3) or the
// global terminal-features / terminal-overrides options (older releases).
export function tmuxTrueColor(env: NodeJS.ProcessEnv = process.env): boolean {
  const queries = [
    ["display-message", "-p", "#{client_termfeatures}"],
    ["show-options", "-gv", "terminal-features"],
    ["show-options", "-gv", "terminal-overrides"],
  ];
  for (const args of queries) {
    try {
      const out = execFileSync("tmux", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 });
      if (/\b(RGB|Tc)\b/.test(out)) return true;
    } catch {
      return false;
    }
  }
  return false;
}

// COLORTERM is the conventional signal; some emulators (and ssh sessions that
// do not forward it) leave it unset, so also accept a known TERM_PROGRAM, a
// "*-direct" terminfo entry, or a tmux session whose terminal has RGB.
export function trueColorEnabled(env: NodeJS.ProcessEnv = process.env, tmuxProbe: (env: NodeJS.ProcessEnv) => boolean = tmuxTrueColor): boolean {
  const ct = (env.COLORTERM ?? "").toLowerCase();
  if (ct === "truecolor" || ct === "24bit") return true;
  if (TRUE_COLOR_PROGRAMS.has((env.TERM_PROGRAM ?? "").toLowerCase())) return true;
  if ((env.TERM ?? "").toLowerCase().endsWith("-direct")) return true;
  return env.TMUX !== undefined && tmuxProbe(env);
}

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// Clear the current terminal line (carriage return + erase-line).
export const CLEAR_LINE = `\r${ESC}[2K`;
// Move the cursor up one row (column unchanged).
export const CURSOR_UP = `${ESC}[1A`;

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const INVISIBLE_RE = /[\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

// Escape terminal control characters in untrusted human-facing text and cap
// its length, appending "…" when truncated.
export function terminalText(value: unknown, limit = 240): string {
  const out: string[] = [];
  let length = 0;
  for (const ch of String(value)) {
    let replacement: string;
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "\n") replacement = "\\n";
    else if (ch === "\r") replacement = "\\r";
    else if (ch === "\t") replacement = " ";
    else if (CONTROL_RE.test(ch)) replacement = `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (INVISIBLE_RE.test(ch)) {
      replacement = cp <= 0xffff ? `\\u${cp.toString(16).padStart(4, "0")}` : `\\U${cp.toString(16).padStart(8, "0")}`;
    } else replacement = ch;
    const remaining = limit - length;
    if (replacement.length > remaining) {
      out.push(replacement.slice(0, Math.max(0, remaining)));
      return out.join("") + "…";
    }
    out.push(replacement);
    length += replacement.length;
  }
  return out.join("");
}

const COMBINING_RE = /\p{M}/u;
// East Asian Wide / Fullwidth blocks (an approximation of unicodedata's F/W).
const WIDE_RE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;

// Terminal-column width of already-sanitised (and ANSI-free) text.
export function terminalWidth(value: string): number {
  let width = 0;
  for (const ch of value) {
    if (COMBINING_RE.test(ch)) continue;
    width += WIDE_RE.test(ch) ? 2 : 1;
  }
  return width;
}

// Sanitise and truncate so the text occupies at most `columns` cells.
export function truncateTerminalText(value: unknown, columns: number): string {
  if (columns < 1) return "";
  const rendered = terminalText(value);
  if (terminalWidth(rendered) <= columns) return rendered;
  if (columns === 1) return "…";
  const kept: string[] = [];
  let used = 0;
  for (const ch of rendered) {
    const w = terminalWidth(ch);
    if (used + w > columns - 1) break;
    kept.push(ch);
    used += w;
  }
  return kept.join("") + "…";
}

// "12.3k" — token counts always in thousands with one decimal, so phase lines
// and the summary table line up.
export function formatTokens(tokens: number): string {
  return `${(tokens / 1000).toFixed(1)}k`;
}

// "12s" · "4m 12s" · "2h 12m" — the h/m/s form every elapsed figure uses.
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function terminalColumns(stream: StreamLike | undefined): number | undefined {
  if (!stream?.isTTY) return undefined;
  const cols = (stream as WriteStream).columns;
  return typeof cols === "number" && cols > 0 ? cols : undefined;
}
