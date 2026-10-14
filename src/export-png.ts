// SVG→Chromium fallback for the drawio PNG export.
//
// drawio-desktop's headless PNG export races MathJax typesetting and, on
// losing, dies on an unhandled UnknownVizError rejection and idles forever
// (observed persistently on math-bearing composites, drawio 30.0.4). The SVG
// export does not wedge — but it can lose the same race SOFTLY, silently
// omitting the math groups. So the fallback is: export SVG, verify every
// source math cell arrived as a typeset MathJax group, then rasterize at the
// target width with headless Chrome.
//
// Chrome notes: regular labels live in <foreignObject> (browser-only SVG),
// which is why a browser engine is required at all. The SVG styles math with
// `currentColor` + `light-dark()` — on a dark-mode host, headless Chrome
// inherits the dark scheme and renders white-on-white via <img>. The HTML
// wrapper forces a light color scheme.

import fs from "node:fs";
import path from "node:path";

import { TeeLog, runCommand } from "./exec.js";
import { PhaseError } from "./errors.js";

const SVG_ATTEMPTS = 3;
const EXPORT_STEP_TIMEOUT_SECS = 120;

const CELL_OPEN_RE = /<mxCell\b[^>]*>/g;
const VALUE_ATTR_RE = /\bvalue="([^"]*)"/;
const MATH_MARKER_RE = /\\\(|\$\$/;

// Cells whose value contains MathJax math (\(...\) or $$...$$).
export function countDrawioMathCells(drawioText: string): number {
  let count = 0;
  for (const tag of drawioText.match(CELL_OPEN_RE) ?? []) {
    const value = VALUE_ATTR_RE.exec(tag)?.[1];
    if (value && MATH_MARKER_RE.test(value)) count++;
  }
  return count;
}

// Each typeset formula arrives in the SVG as a <g data-mml-node="math"> root.
export function svgMathComplete(svgText: string, expectedMathCells: number): boolean {
  const typeset = svgText.match(/data-mml-node="math"/g)?.length ?? 0;
  return typeset >= expectedMathCells;
}

const MACOS_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const PATH_CHROME_NAMES = ["google-chrome", "chromium", "chromium-browser", "chrome"];

export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.AUTOILLUSTRATE_CHROME) {
    return fs.existsSync(env.AUTOILLUSTRATE_CHROME) ? env.AUTOILLUSTRATE_CHROME : null;
  }
  for (const p of MACOS_CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of PATH_CHROME_NAMES) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

function svgIntrinsicSize(svgText: string): { w: number; h: number } | null {
  const w = Number(/\bwidth="(\d+(?:\.\d+)?)px"/.exec(svgText)?.[1]);
  const h = Number(/\bheight="(\d+(?:\.\d+)?)px"/.exec(svgText)?.[1]);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null;
}

export interface SvgFallbackOptions {
  drawioPath: string;
  pngOut: string;
  widthPx: number;
  tee: TeeLog;
  env: NodeJS.ProcessEnv;
}

export interface RobustExportOptions {
  drawioPath: string;
  pngOut: string;
  /** Exactly one of widthPx / scale. */
  widthPx?: number;
  scale?: number;
  tee: TeeLog;
  env: NodeJS.ProcessEnv;
  directAttempts: number;
  directTimeoutSecs: number;
}

// drawio CLI argv for the direct PNG export. Deliberately omits `-e` (embed
// diagram XML into the PNG): the embed path (writePngWithText) is regressed in
// drawio-desktop v30.0.2+ and crashes with a buffer overflow on large
// canvases. The editable .drawio source is preserved alongside every export,
// so embedding it into the PNG is redundant. Exported so a unit test can guard
// against the flag being re-added.
export function drawioPngExportArgs(sizeArgs: string[], pngOut: string, drawioPath: string): string[] {
  return ["-x", "-f", "png", "-b", "10", ...sizeArgs, "-o", pngOut, drawioPath];
}

// Direct drawio PNG export with bounded retries, then the SVG+Chrome
// fallback. The single hardened path for every drawio rasterization in the
// pipeline — orchestrator phases and sub-agents (via `autoillustrate
// export`) alike.
export async function exportDrawioPngRobust(opts: RobustExportOptions): Promise<void> {
  const { drawioPath, pngOut, tee, env } = opts;
  const sizeArgs = opts.widthPx !== undefined ? ["--width", String(opts.widthPx)] : ["--scale", String(opts.scale ?? 1)];
  for (let attempt = 1; attempt <= opts.directAttempts; attempt++) {
    try {
      await runCommand("drawio", drawioPngExportArgs(sizeArgs, pngOut, drawioPath), tee, {
        env,
        timeoutSecs: opts.directTimeoutSecs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      tee.warn("export", `drawio export attempt ${attempt}/${opts.directAttempts} failed (${msg})`);
      continue;
    }
    // drawio (Electron) can also exit 0 without producing output.
    if (fs.existsSync(pngOut)) return;
    tee.warn("export", `drawio exited 0 without producing ${pngOut} (attempt ${attempt}/${opts.directAttempts})`);
  }
  if (!findChrome(env)) {
    throw new PhaseError(
      `drawio export did not produce ${pngOut} (install Google Chrome or set AUTOILLUSTRATE_CHROME for the SVG fallback)`,
      1,
      tee.logPath,
    );
  }
  tee.warn("export", "direct PNG export exhausted — falling back to SVG + headless-Chrome rasterization");
  let widthPx = opts.widthPx;
  if (widthPx === undefined) {
    // --scale mode: rasterize at the diagram's intrinsic width × scale.
    const probe = svgIntrinsicSizeFromDrawio(drawioPath);
    widthPx = Math.ceil((probe ?? 1280) * (opts.scale ?? 1));
  }
  await exportPngViaSvg({ drawioPath, pngOut, widthPx, tee, env });
}

// Best-effort intrinsic width from the drawio page geometry (pageWidth attr);
// null when absent — callers fall back to a sane default.
function svgIntrinsicSizeFromDrawio(drawioPath: string): number | null {
  try {
    const w = Number(/\bpageWidth="(\d+(?:\.\d+)?)"/.exec(fs.readFileSync(drawioPath, "utf8"))?.[1]);
    return Number.isFinite(w) && w > 0 ? w : null;
  } catch {
    return null;
  }
}

// Throws PhaseError when the fallback cannot produce a verified PNG.
export async function exportPngViaSvg(opts: SvgFallbackOptions): Promise<void> {
  const { drawioPath, pngOut, widthPx, tee, env } = opts;
  const chrome = findChrome(env);
  if (!chrome) {
    throw new PhaseError(
      "SVG fallback unavailable: no Chrome/Chromium found (install Google Chrome or set AUTOILLUSTRATE_CHROME)",
      1,
      tee.logPath,
    );
  }

  const expectedMath = countDrawioMathCells(fs.readFileSync(drawioPath, "utf8"));
  const svgOut = pngOut.replace(/\.png$/, ".export.svg");

  let svgText = "";
  for (let attempt = 1; ; attempt++) {
    fs.rmSync(svgOut, { force: true });
    await runCommand("drawio", ["-x", "-f", "svg", "-e", "-b", "10", "-o", svgOut, drawioPath], tee, {
      env,
      timeoutSecs: EXPORT_STEP_TIMEOUT_SECS,
    });
    svgText = fs.existsSync(svgOut) ? fs.readFileSync(svgOut, "utf8") : "";
    if (svgText && svgMathComplete(svgText, expectedMath)) break;
    if (attempt >= SVG_ATTEMPTS) {
      throw new PhaseError(
        `SVG fallback failed: export ${svgText ? `dropped math (${expectedMath} cells expected)` : "produced no file"} after ${SVG_ATTEMPTS} attempts`,
        1,
        tee.logPath,
      );
    }
    tee.warn("export", `SVG attempt ${attempt}/${SVG_ATTEMPTS} ${svgText ? "dropped math groups" : "produced no file"} — retrying`);
  }

  const size = svgIntrinsicSize(svgText);
  if (!size) {
    throw new PhaseError("SVG fallback failed: cannot read SVG intrinsic size", 1, tee.logPath);
  }
  const heightPx = Math.ceil((size.h * widthPx) / size.w);

  // The wrapper forces a light color scheme: the SVG's math uses
  // currentColor + light-dark(), which turns white (invisible on white)
  // when a dark-mode host leaks its scheme into headless Chrome.
  const htmlPath = pngOut.replace(/\.png$/, ".export.html");
  fs.writeFileSync(
    htmlPath,
    `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="only light"><style>
:root{color-scheme:only light}
html,body{margin:0;padding:0;background:#ffffff}
img{display:block;width:${widthPx}px;height:auto;color-scheme:light}
</style></head><body><img src="${path.basename(svgOut)}"></body></html>
`,
  );

  tee.info("export", `rasterizing SVG via headless Chrome (${widthPx}x${heightPx})`);
  fs.rmSync(pngOut, { force: true });
  await runCommand(
    chrome,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--force-device-scale-factor=1",
      `--window-size=${widthPx},${heightPx}`,
      `--screenshot=${pngOut}`,
      `file://${htmlPath}`,
    ],
    tee,
    { env, timeoutSecs: EXPORT_STEP_TIMEOUT_SECS },
  );
  if (!fs.existsSync(pngOut)) {
    throw new PhaseError(`SVG fallback failed: Chrome produced no screenshot at ${pngOut}`, 1, tee.logPath);
  }
  fs.rmSync(htmlPath, { force: true });
  fs.rmSync(svgOut, { force: true });
}
