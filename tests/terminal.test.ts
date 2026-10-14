import assert from "node:assert/strict";
import { test } from "node:test";

import { LOGO_SIZES, SEA_STOPS, SUNRISE_STOPS, gradientRgb, renderLogo, shadeRgb, sunriseRgb, WORDMARK_COLUMNS, WORDMARK_TEXT } from "../src/logo.js";
import {
  colorsEnabled,
  formatDuration,
  trueColorEnabled,
  stripAnsi,
  style,
  terminalText,
  terminalWidth,
  truncateTerminalText,
} from "../src/terminal.js";

const ESC = "\u001b";

test("colorsEnabled: TTY only, NO_COLOR/TERM=dumb win, FORCE_COLOR overrides", () => {
  assert.equal(colorsEnabled({ isTTY: true }, {}), true);
  assert.equal(colorsEnabled({ isTTY: false }, {}), false);
  assert.equal(colorsEnabled(undefined, {}), false);
  assert.equal(colorsEnabled({ isTTY: true }, { NO_COLOR: "" }), false);
  assert.equal(colorsEnabled({ isTTY: true }, { TERM: "dumb" }), false);
  assert.equal(colorsEnabled({ isTTY: false }, { FORCE_COLOR: "1" }), true);
  assert.equal(colorsEnabled({ isTTY: true }, { FORCE_COLOR: "0" }), false);
  assert.equal(colorsEnabled({ isTTY: true }, { NO_COLOR: "1", FORCE_COLOR: "1" }), false);
});

test("trueColorEnabled: COLORTERM, known TERM_PROGRAM, or a *-direct TERM", () => {
  assert.equal(trueColorEnabled({}), false);
  assert.equal(trueColorEnabled({ COLORTERM: "truecolor" }), true);
  assert.equal(trueColorEnabled({ COLORTERM: "24BIT" }), true);
  assert.equal(trueColorEnabled({ COLORTERM: "yes" }), false);
  assert.equal(trueColorEnabled({ TERM_PROGRAM: "iTerm.app" }), true);
  assert.equal(trueColorEnabled({ TERM_PROGRAM: "WezTerm" }), true);
  assert.equal(trueColorEnabled({ TERM_PROGRAM: "vscode" }), true);
  assert.equal(trueColorEnabled({ TERM_PROGRAM: "Apple_Terminal" }), false);
  assert.equal(trueColorEnabled({ TERM: "xterm-direct" }), true);
  assert.equal(trueColorEnabled({ TERM: "tmux-direct" }), true);
  assert.equal(trueColorEnabled({ TERM: "xterm-256color" }), false);
});

test("trueColorEnabled: inside tmux, defers to the tmux probe only when TMUX is set", () => {
  const probed: NodeJS.ProcessEnv[] = [];
  const yes = (env: NodeJS.ProcessEnv) => (probed.push(env), true);
  const no = () => false;
  assert.equal(trueColorEnabled({ TMUX: "/tmp/tmux-1/default,1,0" }, yes), true);
  assert.equal(probed.length, 1);
  assert.equal(trueColorEnabled({ TMUX: "/tmp/tmux-1/default,1,0" }, no), false);
  assert.equal(trueColorEnabled({ TERM: "screen" }, yes), false);
  assert.equal(probed.length, 1);
  assert.equal(trueColorEnabled({ TMUX: "x", COLORTERM: "truecolor" }, no), true);
});

test("style wraps text only when enabled and never alters the text itself", () => {
  assert.equal(style("done", "success", false), "done");
  const styled = style("done", "success", true);
  assert.notEqual(styled, "done");
  assert.equal(stripAnsi(styled), "done");
  assert.equal(style("", "failure", true), "");
});

test("terminalText escapes control characters and truncates with an ellipsis", () => {
  assert.equal(terminalText(`a${ESC}[31mb\n\tc`), "a\\x1b[31mb\\n c");
  assert.equal(terminalText("x".repeat(10), 4), "xxxx…");
  assert.equal(terminalText("abc", 3), "abc");
  assert.equal(terminalText("zero\u200bwidth"), "zero\\u200bwidth");
});

test("terminalWidth counts wide glyphs as two cells and combining marks as zero", () => {
  assert.equal(terminalWidth("abc"), 3);
  assert.equal(terminalWidth("日本"), 4);
  assert.equal(terminalWidth("e\u0301"), 1);
});

test("truncateTerminalText fits the column budget", () => {
  assert.equal(truncateTerminalText("Rendering 4 panels…", 100), "Rendering 4 panels…");
  assert.equal(truncateTerminalText("Rendering 4 panels…", 10), "Rendering…");
  assert.equal(truncateTerminalText("abc", 1), "…");
  assert.equal(truncateTerminalText("abc", 0), "");
});

test("formatDuration uses the h/m/s form", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(59_900), "59s");
  assert.equal(formatDuration(60_000), "1m 0s");
  assert.equal(formatDuration(252_000), "4m 12s");
  assert.equal(formatDuration(2 * 3_600_000 + 12 * 60_000 + 53_000), "2h 12m");
  assert.equal(formatDuration(-5), "0s");
});

test("renderLogo picks the largest Auto → Illustrate art that fits, and the plain name below the smallest", () => {
  const plain = renderLogo({ colors: false });
  assert.deepEqual(plain, LOGO_SIZES[0].art); // no width constraint → the big version
  assert.ok(LOGO_SIZES.every((s) => s.art.length === s.mask.length && s.art.every((l, i) => [...l].length === [...s.mask[i]].length)), "art and mask layers stay aligned");
  assert.ok(LOGO_SIZES.some((s) => s.columns <= 80), "a block version must fit an 80-column terminal");
  assert.deepEqual(renderLogo({ colors: false, columns: 80 }), LOGO_SIZES[1].art);
  assert.deepEqual(renderLogo({ colors: false, columns: WORDMARK_COLUMNS }), LOGO_SIZES[2].art);
  assert.deepEqual(renderLogo({ colors: false, columns: WORDMARK_COLUMNS - 1 }), [WORDMARK_TEXT]);
  const tinted = renderLogo({ colors: true, columns: 200 });
  assert.deepEqual(tinted.map(stripAnsi), plain);
  assert.equal(stripAnsi(renderLogo({ colors: true, columns: 40 })[0]), WORDMARK_TEXT);
});

test("wordmark gradients: sea on Auto, sunrise on Illustrate, shadows per row, arrow sweeping between them", () => {
  const codes = (line: string) => [...line.matchAll(/38;(?:5;(\d+)|2;(\d+;\d+;\d+))m/g)].map((m) => m[1] ?? m[2]);
  const rgbOf = (code: string) => code.split(";").map(Number);
  const smooth = renderLogo({ colors: true, columns: 200, trueColor: true });
  const rows = smooth.map(codes);
  const { art, mask } = LOGO_SIZES[0];
  const letterRows = art.map((_, i) => i).filter((i) => /[A-H]/.test(mask[i]));
  assert.equal(letterRows.length, 5);
  // the first painted cell of the top/bottom letter rows is a letter body: foam / indigo exactly
  assert.equal(rows[letterRows[0]][0], SEA_STOPS[0].join(";"));
  assert.equal(rows[letterRows[4]][0], SEA_STOPS[SEA_STOPS.length - 1].join(";"));
  const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const rowRgb = [0, 1, 2, 3, 4].map((row) => gradientRgb(row, 5));
  for (let i = 1; i < rowRgb.length; i++) assert.ok(luminance(rowRgb[i]) < luminance(rowRgb[i - 1]), "each row is darker than the one above");
  assert.ok(rowRgb.every(([r, , b]) => b > r), "every row stays on the cool, watery side");
  assert.ok(rowRgb.every((rgb) => luminance(rgb) > 30 && luminance(rgb) < 240), "no row is pure white or black");
  const sunRgb = [0, 1, 2, 3, 4].map((row) => sunriseRgb(row, 5));
  assert.deepEqual(sunRgb[0], SUNRISE_STOPS[0]);
  assert.deepEqual(sunRgb[4], SUNRISE_STOPS[SUNRISE_STOPS.length - 1]);
  for (let i = 1; i < sunRgb.length; i++) assert.ok(luminance(sunRgb[i]) < luminance(sunRgb[i - 1]), "the sunrise darkens downwards too");
  assert.ok(sunRgb.every(([r, , b]) => r > b), "every Illustrate row stays on the warm side");
  const indigo = SEA_STOPS[SEA_STOPS.length - 1];
  const plum = SUNRISE_STOPS[SUNRISE_STOPS.length - 1];
  const seaShade = (i: number) => shadeRgb(rowRgb[i], indigo);
  const sunShade = (i: number) => shadeRgb(sunRgb[i], plum);
  for (let i = 0; i < 5; i++) {
    assert.ok(luminance(seaShade(i)) < luminance(rowRgb[i]) && luminance(sunShade(i)) < luminance(sunRgb[i]), "a shadow is darker than its row");
    assert.ok(seaShade(i)[2] > seaShade(i)[0] && sunShade(i)[0] > sunShade(i)[2], "a shadow keeps its side's hue");
  }
  // shadows follow the row they fall from: every letter row carries that row's two shades,
  // and the shadow-only row carries only the bottom row's shades
  for (const [i, r] of letterRows.entries()) {
    assert.ok(rows[r].includes(seaShade(i).join(";")) && rows[r].includes(sunShade(i).join(";")), `row ${i} shadows`);
  }
  const shadowRow = mask.findIndex((m) => /^\s*S[Ss ]*$/.test(m) && m.includes("S"));
  assert.deepEqual([...new Set(rows[shadowRow])].sort(), [seaShade(4).join(";"), sunShade(4).join(";")].sort());
  // the underlines take the bottom colour of the word above them
  const underlineRow = art.findIndex((l) => l.includes("┬"));
  assert.deepEqual(rows[underlineRow], [indigo.join(";"), plum.join(";")]);
  // the arrow runs a continuous gradient from the Auto underline colour to the Illustrate one
  const stemRow = art.findIndex((l) => l.includes("│"));
  const railRow = art.findIndex((l) => l.includes("└"));
  const arrowRgb = [...codes(smooth[stemRow]), ...codes(smooth[railRow])].map(rgbOf);
  const [stemCode, headCode] = codes(smooth[stemRow]);
  assert.deepEqual(rgbOf(stemCode), indigo);
  assert.deepEqual(rgbOf(headCode), plum);
  const rail = codes(smooth[railRow]).map(rgbOf);
  assert.ok(rail.length > 20, "each cell of the rail gets its own step");
  for (let i = 1; i < rail.length; i++) assert.ok(rail[i][0] >= rail[i - 1][0] && rail[i][2] <= rail[i - 1][2], "the rail warms monotonically");
  const between = (c: number, i: number) => c >= Math.min(indigo[i], plum[i]) && c <= Math.max(indigo[i], plum[i]);
  assert.ok(arrowRgb.every((rgb) => rgb.every(between)), "arrow stays between indigo and plum");
  // every letter row carries both sweeps: sea on the left, sunrise on the right
  for (const [i, r] of letterRows.entries()) {
    assert.ok(rows[r].includes(gradientRgb(i, 5).join(";")) && rows[r].includes(sunriseRgb(i, 5).join(";")));
  }
  const banded = renderLogo({ colors: true, columns: 200 });
  assert.deepEqual(banded.map(stripAnsi), smooth.map(stripAnsi));
  // the compact block sizes run the same sweep over their five letter rows
  for (const columns of [80, WORDMARK_COLUMNS]) {
    const compact = renderLogo({ colors: true, columns, trueColor: true });
    const size = LOGO_SIZES.find((s) => s.columns <= columns)!;
    const letterRowsOf = size.art.map((_, i) => i).filter((i) => /[A-H]/.test(size.mask[i]));
    assert.equal(letterRowsOf.length, 5);
    const top = new Set(codes(compact[letterRowsOf[0]]));
    const bottom = new Set(codes(compact[letterRowsOf[4]]));
    assert.ok(top.has(SEA_STOPS[0].join(";")) && top.has(SUNRISE_STOPS[0].join(";")));
    assert.ok(bottom.has(SEA_STOPS[3].join(";")) && bottom.has(SUNRISE_STOPS[3].join(";")));
    assert.ok(size.mask.some((m) => m.includes("S")) && size.mask.some((m) => m.includes("s")), "compact sizes carry shadows");
    const stem = codes(compact[compact.length - 2]);
    assert.equal(stem[0], SEA_STOPS[3].join(";"));
    assert.equal(stem[stem.length - 1], SUNRISE_STOPS[3].join(";"));
  }
  // narrow fallback: a single line, so the same sweep runs left → right
  assert.ok(codes(renderLogo({ colors: true, columns: 40, trueColor: true })[0]).length >= 5);
});
