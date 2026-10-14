import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

function runPython(source: string): string {
  const python = process.env.AUTOILLUSTRATE_PYTHON ?? "python3";
  const result = spawnSync(python, ["-c", source], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test("Gemini aspect-ratio snapping only emits SDK-supported ratios", () => {
  const stdout = runPython(`
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("enhance", Path("scripts/enhance.py"))
enhance = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(enhance)

supported = {"1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"}
assert set(enhance._GEMINI_ASPECT_RATIOS) == supported, enhance._GEMINI_ASPECT_RATIOS

for width, height in [(4000, 1000), (1000, 4000), (500, 400), (400, 500)]:
    assert enhance.fit_gemini_aspect(width, height) in supported

print("ok")
`);
  assert.equal(stdout, "ok");
});

test("resolve_model routes registry aliases, gemini ids, and other ids to the right backend", () => {
  const stdout = runPython(`
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("enhance", Path("scripts/enhance.py"))
enhance = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(enhance)

for name in ["nanobanana", "gemini-3.1-flash-image", "gpt-image-1", "codex"]:
    s = enhance.resolve_model(name)
    print(name, s["backend"], s["model"], s.get("max_image_size", "-"))
`);
  assert.deepEqual(stdout.split("\n"), [
    "nanobanana gemini gemini-3.1-flash-image 2K",
    "gemini-3.1-flash-image gemini gemini-3.1-flash-image 2K",
    "gpt-image-1 openai gpt-image-1 -",
    "codex codex gpt-image-2 (codex $imagegen) -",
  ]);
});

test("embedded matplotlib plots are located in the export, refined by template match, and listed in the prompt", () => {
  const stdout = runPython(`
import base64, importlib.util, io, tempfile
from pathlib import Path
from PIL import Image, ImageDraw

spec = importlib.util.spec_from_file_location("enhance", Path("scripts/enhance.py"))
enhance = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(enhance)

# A 60x30 glyph with structure (so the template match has a unique optimum).
glyph = Image.new("RGBA", (60, 30), (255, 255, 255, 255))
d = ImageDraw.Draw(glyph)
d.line([(2, 27), (57, 4)], fill=(80, 40, 160, 255), width=3)
d.rectangle([(5, 5), (15, 15)], fill=(200, 60, 60, 255))
d.rectangle([(40, 18), (55, 26)], fill=(60, 160, 90, 255))
buf = io.BytesIO(); glyph.save(buf, format="PNG"); b64 = base64.b64encode(buf.getvalue()).decode()

# Diagram: content bounds (20,30)-(620,330); image cell at (200,100) 120x60.
drawio = f'''<mxfile><diagram><mxGraphModel><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="a" value="A" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="20" y="30" width="100" height="50" as="geometry"/></mxCell>
<mxCell id="b" value="B" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="520" y="280" width="100" height="50" as="geometry"/></mxCell>
<mxCell id="p1__glyph" style="shape=image;imageAspect=0;image=data:image/png,{b64};" vertex="1" parent="1"><mxGeometry x="200" y="100" width="120" height="60" as="geometry"/></mxCell>
<mxCell id="e" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="300" y="55"/></Array><mxPoint x="3" y="-7" as="offset"/></mxGeometry></mxCell>
</root></mxGraphModel></diagram></mxfile>'''

# Fake export: scale 1.5, border 10 -> canvas (600+20)*1.5 x (300+20)*1.5.
scale = 1.5
W, H = round(620 * scale), round(320 * scale)
canvas = Image.new("RGB", (W, H), (255, 255, 255))
true_x, true_y = round((200 - 20 + 10) * scale) + 5, round((100 - 30 + 10) * scale) - 4  # nudged off the estimate
gw, gh = round(120 * scale), round(60 * scale)
canvas.paste(glyph.convert("RGB").resize((gw, gh), Image.Resampling.LANCZOS), (true_x, true_y))

with tempfile.TemporaryDirectory() as td:
    td = Path(td)
    (td / "full_figure.drawio").write_text(drawio)
    canvas.save(td / "full_figure.png")
    (td / "placeholders_p1_mpl.jsonl").write_text('{"id": "1", "kind": "line_plot", "description": "a rising line", "script_filename": "mpl_p1_1.py", "intended_dimensions": {"w": 120, "h": 60}}\\n')
    (td / "mpl_p1_1.png").write_bytes(buf.getvalue())

    embeds = enhance.discover_embedded_images(td / "full_figure.drawio", (W, H))
    assert [e.cell_id for e in embeds] == ["p1__glyph"], embeds
    est = embeds[0].rect
    assert abs(est[0] - (true_x - 5)) <= 1 and abs(est[1] - (true_y + 4)) <= 1, (est, true_x, true_y)
    assert (est[2], est[3]) == (gw, gh), est

    enhance.refine_embedded_images(td / "full_figure.png", embeds)
    assert embeds[0].rect == (true_x, true_y, gw, gh), (embeds[0].rect, (true_x, true_y))
    assert embeds[0].match_error is not None and embeds[0].match_error < 5, embeds[0].match_error

    enhance.annotate_embedded_images(embeds, td)
    assert (embeds[0].panel, embeds[0].index, embeds[0].kind) == ("p1", "1", "line_plot"), vars(embeds[0])

    block = enhance.build_protected_block(embeds, (W, H))
    assert "PRE-RENDERED PLOTS" in block, block
    assert "panel \`p1\`, plot 1 (line_plot)" in block and "a rising line" in block, block
    assert f"x {100*true_x/W:.1f}%" in block, block
    assert enhance.build_protected_block([], (W, H)) == ""
    assert "PRE-RENDERED PLOTS" in enhance.build_prompt(None, "full-width", protected_block=block)
    assert "PRE-RENDERED PLOTS" not in enhance.build_prompt(None, "full-width")

print("ok")
`);
  assert.equal(stdout, "ok");
});

test("gpt-image size snap honours the API pixel floor and returns composites 1:1 below the edge cap", () => {
  const stdout = runPython(`
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("enhance", Path("scripts/enhance.py"))
enhance = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(enhance)

assert enhance.DEFAULT_MAX_EDGE == 2560, enhance.DEFAULT_MAX_EDGE
for w, h in [(1024, 440), (1024, 576), (1024, 420), (1024, 342), (2560, 1057), (5000, 1600)]:
    ow, oh = map(int, enhance.fit_gpt_image_size(w, h).split("x"))
    assert ow % 16 == 0 and oh % 16 == 0, (w, h, ow, oh)
    assert max(ow, oh) <= 3840, (w, h, ow, oh)
    assert 655_360 <= ow * oh <= 8_294_400, (w, h, ow, oh)
    assert max(ow, oh) / min(ow, oh) <= 3.0, (w, h, ow, oh)
print(enhance.fit_gpt_image_size(1536, 864), enhance.fit_gpt_image_size(1536, 656), enhance.fit_gpt_image_size(1536, 592), enhance.fit_gpt_image_size(1024, 576))
`);
  assert.equal(stdout, "1536x864 1536x656 1536x592 1088x608");
});
