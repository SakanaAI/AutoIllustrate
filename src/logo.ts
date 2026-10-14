// Terminal wordmark for autoillustrate — "Auto → Illustrate", printed once at
// the top of a run. "Auto" is tinted with a vertical sea gradient (shallow
// water down to deep Japanese indigo — a nod to Sakana) and "Illustrate" with
// its chromatic opposite, a sunrise (pale gold down to plum). Each shadow is
// a darker shade of the row it falls from, each underline takes the bottom
// row of its word, and the return arrow sweeps from the one to the other.
//
// Each size is two layers of identical shape: the characters, and a mask
// where every cell names a colour key. The big version is hand-drawn (edit
// both layers together so they stay aligned); the compact ones are built
// from block-letter glyph tables, shadows included.
//
// Mask keys: A–H = Auto letter rows (sea, top → bottom), 1–8 = Illustrate
// letter rows (sunrise), S / s = Auto / Illustrate letter shadows,
// a = Auto underline, c = Illustrate underline, e = arrow line, h = arrowhead.

import { paint256, paintRgb, style, terminalWidth } from "./terminal.js";

const BIG = String.raw`
  █████╗ ██╗   ██╗████████╗ ██████╗     ██╗██╗     ██╗     ██╗   ██╗███████╗████████╗██████╗  █████╗ ████████╗███████╗
 ██╔══██╗██║   ██║╚══██╔══╝██╔═══██╗    ██║██║     ██║     ██║   ██║██╔════╝╚══██╔══╝██╔══██╗██╔══██╗╚══██╔══╝██╔════╝
 ███████║██║   ██║   ██║   ██║   ██║    ██║██║     ██║     ██║   ██║███████╗   ██║   ██████╔╝███████║   ██║   █████╗
 ██╔══██║██║   ██║   ██║   ██║   ██║    ██║██║     ██║     ██║   ██║╚════██║   ██║   ██╔══██╗██╔══██║   ██║   ██╔══╝
 ██║  ██║╚██████╔╝   ██║   ╚██████╔╝    ██║███████╗███████╗╚██████╔╝███████║   ██║   ██║  ██║██║  ██║   ██║   ███████╗
 ╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝     ╚═╝╚══════╝╚══════╝ ╚═════╝ ╚══════╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚══════╝
──────────────────┬──────────────────  ────────────────────────────────────────────────────────────────────────────────
                  │                                                           ▲
                  └───────────────────────────────────────────────────────────┘
`;

const BIG_MASK = String.raw`
  AAAAAS AAS   AASAAAAAAAAS AAAAAAS     11s11s     11s     11s   11s1111111s11111111s111111s  11111s 11111111s1111111s
 BBSSSBBSBBS   BBSSSSBBSSSSBBSSSSBBS    22s22s     22s     22s   22s22sssssssss22ssss22sss22s22sss22ssss22ssss22ssssss
 CCCCCCCSCCS   CCS   CCS   CCS   CCS    33s33s     33s     33s   33s3333333s   33s   333333ss3333333s   33s   33333s
 DDSSSDDSDDS   DDS   DDS   DDS   DDS    44s44s     44s     44s   44ssssss44s   44s   44sss44s44sss44s   44s   44ssss
 EES  EESSEEEEEESS   EES   SEEEEEESS    55s5555555s5555555ss555555ss5555555s   55s   55s  55s55s  55s   55s   5555555s
 SSS  SSS SSSSSSS    SSS    SSSSSSS     sssssssssssssssssss sssssss ssssssss   sss   sss  ssssss  sss   sss   ssssssss
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
                  e                                                           h
                  eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
`;

// Compact sizes: filled block letters, built from 5-row glyph tables so the
// underlines and the return arrow can be laid out under each word.
type Font = Record<string, string[]>;

const FONT_WIDE: Font = {
  A: [" ███ ", "█   █", "█████", "█   █", "█   █"],
  E: ["████", "█   ", "███ ", "█   ", "████"],
  I: ["█", "█", "█", "█", "█"],
  L: ["█   ", "█   ", "█   ", "█   ", "████"],
  O: [" ██ ", "█  █", "█  █", "█  █", " ██ "],
  R: ["███ ", "█  █", "███ ", "█ █ ", "█  █"],
  S: [" ███", "█   ", " ██ ", "   █", "███ "],
  T: ["█████", "  █  ", "  █  ", "  █  ", "  █  "],
  U: ["█  █", "█  █", "█  █", "█  █", " ██ "],
};

const FONT_NARROW: Font = {
  A: [" █ ", "█ █", "███", "█ █", "█ █"],
  E: ["███", "█  ", "██ ", "█  ", "███"],
  I: ["█", "█", "█", "█", "█"],
  L: ["█  ", "█  ", "█  ", "█  ", "███"],
  O: ["███", "█ █", "█ █", "█ █", "███"],
  R: ["██ ", "█ █", "██ ", "█ █", "█ █"],
  S: ["███", "█  ", "███", "  █", "███"],
  T: ["███", " █ ", " █ ", " █ ", " █ "],
  U: ["█ █", "█ █", "█ █", "█ █", "███"],
};

const ROWS = 5;

// ANSI-shadow style: each empty cell to the right of or below a block gets a
// box-drawing piece, chosen from which of its left / upper / upper-left
// neighbours are filled. Returns the glyph rows plus one shadow row, each one
// cell wider than the glyph.
function shadowed(glyph: string[]): string[] {
  const w = glyph[0].length + 1;
  const filled = (x: number, y: number) => y >= 0 && y < ROWS && x >= 0 && glyph[y][x] === "█";
  const out: string[] = [];
  for (let y = 0; y <= ROWS; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      if (filled(x, y)) {
        row += "█";
        continue;
      }
      const [l, u, ul] = [filled(x - 1, y), filled(x, y - 1), filled(x - 1, y - 1)];
      row += l && u ? "╔" : l ? (ul ? "║" : "╗") : u ? (ul ? "═" : "╚") : ul ? "╝" : " ";
    }
    out.push(row);
  }
  return out;
}

// Letters butt up against each other; the shadow column is the spacing.
function wordRows(word: string, font: Font): string[] {
  const rows = Array<string>(ROWS + 1).fill("");
  for (const letter of word) {
    const glyph = font[letter];
    if (!glyph) throw new Error(`no glyph for ${letter}`);
    shadowed(glyph).forEach((r, i) => (rows[i] += r));
  }
  return rows;
}

const SHADOW_GLYPHS = /[╔║╗═╚╝]/g;

// Lay out "AUTO  ILLUSTRATE" with one underline per word and the arrow
// returning from the middle of Auto to the middle of Illustrate. Returns the
// two layers in the same format as the hand-drawn big version.
function blockLogo(font: Font): { art: string; mask: string } {
  const auto = wordRows("AUTO", font);
  const illus = wordRows("ILLUSTRATE", font);
  const [aw, iw] = [auto[0].length, illus[0].length];
  const autoLine = aw + 2; // underline overhangs the word by one cell each side
  const illusStart = autoLine + 2;
  const art: string[] = [];
  const mask: string[] = [];
  const keyed = (row: string, letter: string, shadow: string) => row.replace(/█/g, letter).replace(SHADOW_GLYPHS, shadow);
  for (let r = 0; r <= ROWS; r++) {
    const line = ` ${auto[r]}   ${illus[r]}`;
    art.push(line.trimEnd());
    const left = ` ${keyed(auto[r], "ABCDEFGH"[r] ?? " ", "S")}`;
    mask.push(`${left}   ${keyed(illus[r], "12345678"[r] ?? " ", "s")}`.trimEnd());
  }
  const stem = Math.floor(autoLine / 2);
  const head = illusStart + Math.floor((iw + 2) / 2);
  art.push(`${"─".repeat(stem)}┬${"─".repeat(autoLine - stem - 1)}  ${"─".repeat(iw + 2)}`);
  mask.push(`${"a".repeat(autoLine)}  ${"c".repeat(iw + 2)}`);
  art.push(`${" ".repeat(stem)}│${" ".repeat(head - stem - 1)}▲`);
  mask.push(`${" ".repeat(stem)}e${" ".repeat(head - stem - 1)}h`);
  art.push(`${" ".repeat(stem)}└${"─".repeat(head - stem - 1)}┘`);
  mask.push(`${" ".repeat(stem)}e${"e".repeat(head - stem - 1)}e`);
  return { art: art.join("\n"), mask: mask.join("\n") };
}

const MEDIUM = blockLogo(FONT_WIDE);
const SMALL = blockLogo(FONT_NARROW);

export interface LogoSize {
  art: string[];
  mask: string[];
  columns: number;
}

function layers(art: string, mask: string): LogoSize {
  const artLines = art.replace(/^\n|\n$/g, "").split("\n");
  const maskLines = mask.replace(/^\n|\n$/g, "").split("\n");
  return { art: artLines, mask: maskLines, columns: Math.max(...artLines.map(terminalWidth)) };
}

// Largest first; renderLogo picks the first that fits the terminal.
export const LOGO_SIZES: LogoSize[] = [layers(BIG, BIG_MASK), layers(MEDIUM.art, MEDIUM.mask), layers(SMALL.art, SMALL.mask)];

export const WORDMARK_TEXT = "AutoIllustrate";
// Narrowest block version; below this the plain name is printed instead.
export const WORDMARK_COLUMNS = LOGO_SIZES[LOGO_SIZES.length - 1].columns;

type Rgb = [number, number, number];

// Top → bottom: sea foam in the shallows, turquoise, open-ocean blue, and
// the deep indigo (紺, "kon") of Japanese textiles. Kept calm and cool so the
// header reads as water rather than as an alert.
export const SEA_STOPS: Rgb[] = [
  [0xdf, 0xf3, 0xf7], // #DFF3F7 foam
  [0x3f, 0xb8, 0xc9], // #3FB8C9 turquoise
  [0x1f, 0x6f, 0xb2], // #1F6FB2 ocean
  [0x2e, 0x45, 0x96], // #2E4596 indigo
];

// The complement of the sea, run the same way: pale dawn light at the top,
// amber, the orange of the disc, and the plum the sky keeps at the horizon.
export const SUNRISE_STOPS: Rgb[] = [
  [0xff, 0xf3, 0xc4], // #FFF3C4 dawn gold
  [0xff, 0xb7, 0x4d], // #FFB74D amber
  [0xf0, 0x62, 0x3e], // #F0623E sunrise orange
  [0x7b, 0x24, 0x52], // #7B2452 plum
];

// How far inside the endpoints the sweep is sampled (0 = use them exactly).
// Left at 0: no stop is pure white or black, so every row stays visible on
// both light and dark backgrounds.
const GRADIENT_INSET = 0;

function ansi256([r, g, b]: Rgb): number {
  const q = (c: number) => Math.round((c * 5) / 255);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

// Colour at position `index` of `count` along the piecewise-linear sweep
// through `stops` (inset from both ends, see GRADIENT_INSET).
function sweepRgb(stops: Rgb[], index: number, count: number): Rgb {
  const raw = count <= 1 ? 0.5 : index / (count - 1);
  const t = GRADIENT_INSET + raw * (1 - 2 * GRADIENT_INSET);
  const segments = stops.length - 1;
  const seg = Math.min(segments - 1, Math.floor(t * segments));
  const local = t * segments - seg;
  const [from, to] = [stops[seg], stops[seg + 1]];
  const mix = (a: number, b: number) => Math.round(a + local * (b - a));
  return [mix(from[0], to[0]), mix(from[1], to[1]), mix(from[2], to[2])];
}

export function gradientRgb(index: number, count: number): Rgb {
  return sweepRgb(SEA_STOPS, index, count);
}

export function sunriseRgb(index: number, count: number): Rgb {
  return sweepRgb(SUNRISE_STOPS, index, count);
}

export function gradientColor(index: number, count: number): number {
  return ansi256(gradientRgb(index, count));
}

const SEA_ROWS = "ABCDEFGH";
const SUNRISE_ROWS = "12345678";

// A shadow is its row's letter colour pulled halfway toward the palette's
// deepest stop and dimmed, so it stays the same hue as what casts it.
export function shadeRgb(rgb: Rgb, deepest: Rgb): Rgb {
  return rgb.map((c, i) => Math.round((c + deepest[i]) / 2 * 0.7)) as Rgb;
}

function mixRgb(from: Rgb, to: Rgb, t: number): Rgb {
  return from.map((c, i) => Math.round(c + (to[i] - c) * t)) as Rgb;
}

// Everything the colour of a cell can depend on, worked out once per size:
// which rows hold letters (so shadows know which row they fall from) and the
// arrow's path (so it can run a gradient from stem to head).
interface Palette {
  seaKeys: string;
  sunriseKeys: string;
  letterRows: number[];
  arrow: { top: number; bottom: number; stem: number; head: number; length: number };
}

function buildPalette(mask: string[]): Palette {
  const used = (keys: string) => [...keys].filter((k) => mask.some((m) => m.includes(k))).join("");
  const letterRows = mask.map((m, i) => i).filter((i) => /[A-H1-8]/.test(mask[i]));
  const cells = mask.flatMap((m, r) => [...m].map((k, c) => ({ k, r, c })).filter(({ k }) => k === "e" || k === "h"));
  const rowsOf = cells.map((x) => x.r);
  const colsOf = cells.map((x) => x.c);
  const [top, bottom, stem, head] = [Math.min(...rowsOf), Math.max(...rowsOf), Math.min(...colsOf), Math.max(...colsOf)];
  return { seaKeys: used(SEA_ROWS), sunriseKeys: used(SUNRISE_ROWS), letterRows, arrow: { top, bottom, stem, head, length: 2 * (bottom - top) + (head - stem) } };
}

// Colour of the letter row at art row `row` for one palette; rows past the
// last letter row (the shadow-only row) take the bottom colour.
function rowColour(p: Palette, row: number, sea: boolean): Rgb {
  const keys = sea ? p.seaKeys : p.sunriseKeys;
  const at = p.letterRows.indexOf(row);
  const i = at >= 0 ? Math.min(at, keys.length - 1) : keys.length - 1;
  return sea ? gradientRgb(i, keys.length) : sunriseRgb(i, keys.length);
}

function bottomColour(p: Palette, sea: boolean): Rgb {
  const n = (sea ? p.seaKeys : p.sunriseKeys).length;
  return sea ? gradientRgb(n - 1, n) : sunriseRgb(n - 1, n);
}

// Distance along the arrow from the stem's top to the head, in cells.
function arrowDistance(p: Palette, row: number, col: number): number {
  const { top, bottom, stem, head } = p.arrow;
  if (col === stem) return row - top;
  if (row === bottom) return bottom - top + (col - stem);
  return bottom - top + (head - stem) + (bottom - row);
}

// Colour for one mask cell, or undefined for unpainted cells.
function cellRgb(p: Palette, key: string, row: number, col: number): Rgb | undefined {
  const sea = p.seaKeys.indexOf(key);
  if (sea >= 0) return gradientRgb(sea, p.seaKeys.length);
  const sun = p.sunriseKeys.indexOf(key);
  if (sun >= 0) return sunriseRgb(sun, p.sunriseKeys.length);
  switch (key) {
    case "S":
      return shadeRgb(rowColour(p, row, true), SEA_STOPS[SEA_STOPS.length - 1]);
    case "s":
      return shadeRgb(rowColour(p, row, false), SUNRISE_STOPS[SUNRISE_STOPS.length - 1]);
    case "a":
      return bottomColour(p, true);
    case "c":
      return bottomColour(p, false);
    case "e":
    case "h":
      return mixRgb(bottomColour(p, true), bottomColour(p, false), arrowDistance(p, row, col) / Math.max(p.arrow.length, 1));
    default:
      return undefined;
  }
}

// Paint one art line by its mask line, coalescing runs of the same colour so
// the escape codes stay compact.
function tintByMask(line: string, mask: string, p: Palette, row: number, trueColor: boolean): string {
  let out = "";
  let run = "";
  let runKey = "";
  let runPaint = (text: string) => text;
  const flush = () => {
    if (run) out += runPaint(run);
    run = "";
  };
  const keys = [...mask];
  [...line].forEach((ch, col) => {
    const rgb = cellRgb(p, keys[col] ?? " ", row, col);
    const key = rgb ? (trueColor ? rgb.join(",") : String(ansi256(rgb))) : "";
    if (key !== runKey) {
      flush();
      runKey = key;
      runPaint = !rgb ? (text) => text : trueColor ? (text) => paintRgb(text, rgb) : (text) => paint256(text, ansi256(rgb));
    }
    run += ch;
  });
  flush();
  return out;
}

// One-line narrow fallback: no rows to sweep down, so "Auto" runs the sea
// left → right and "Illustrate" the sunrise.
function tintAcross(trueColor: boolean): string {
  const paintWord = (word: string, sweep: (i: number, n: number) => Rgb) =>
    [...word].map((ch, i) => (trueColor ? paintRgb(ch, sweep(i, word.length)) : paint256(ch, ansi256(sweep(i, word.length))))).join("");
  return paintWord("Auto", gradientRgb) + paintWord("Illustrate", sunriseRgb);
}

// Lines of the wordmark. `columns` undefined = not a terminal (no width
// constraint, e.g. a redirected log), where the largest version still prints
// so a captured log starts the same way an interactive run does.
export function renderLogo(opts: { colors: boolean; columns?: number; trueColor?: boolean }): string[] {
  const trueColor = opts.trueColor ?? false;
  const size = LOGO_SIZES.find((s) => opts.columns === undefined || s.columns <= opts.columns);
  if (!size) return [opts.colors ? tintAcross(trueColor) : WORDMARK_TEXT];
  if (!opts.colors) return [...size.art];
  const palette = buildPalette(size.mask);
  return size.art.map((line, i) => tintByMask(line, size.mask[i] ?? "", palette, i, trueColor));
}

export function renderTagline(colors: boolean): string {
  return style("publication-grade academic figures from a methodology brief", "detail", colors);
}
