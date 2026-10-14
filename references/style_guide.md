# Figure style guide — the "NeurIPS look" for draw.io panels

This is the shared aesthetic reference for the pipeline. The **Style phase
(Phase 1.5)** reads it and *designs* ONE coherent look for the whole figure,
recording concrete choices in `$WORKDIR/style.md`; every Phase 2 panel agent
then draws its fills, stroke colors, corner radii, and fonts from that
`style.md` (not from this file directly, and never from draw.io's defaults).

Everything here is **options, not mandates.** The goal is a clean,
publication-grade figure that looks professional and reads clearly —
*not* one uniform house style. Different papers want different looks (see
"Domain vibes" below); pick what fits the content and stay internally
consistent.

---

## 1. The look

Modern conference figures read as **"soft tech / scientific pastels":**
light desaturated backgrounds to organize structure, medium saturation
reserved for active modules, and a single strong accent reserved for the
one thing that matters most (the output, the loss, the result). Clean
modular blocks; clear left-to-right or top-down flow; generous but balanced
white space.

What makes a figure look **amateur** (each undercuts a publication-grade look — avoid):
- draw.io defaults: the stock light-blue `#dae8fc` fill with a **black**
  outline. Never ship these.
- Neon / fully-saturated fills used as zone backgrounds.
- Saturated / primary-color fills on functional module boxes (garish
  red / orange / blue blocks). Keep module fills in a restrained register;
  reserve high saturation for the accent (output / loss / result) — unless
  the figure deliberately uses content-driven color coding (§2, decision 2).
- A black canvas background (keep it white/transparent).
- The same stroke style for data flow and gradient/auxiliary flow.
- Mixed fonts (a serif "Encoder" label next to sans labels).
- Emoji glyphs as icons — they render as empty tofu boxes in headless
  export. Use a short text label, a real shape, or a style attribute
  instead.

---

## 2. Designing the palette (derive one — don't pick from a menu)

The Style phase **designs a bespoke palette for this specific figure**, with a
one-line rationale, rather than selecting one of a few stock looks. This is
deliberate: independent agents handed the same short menu converge on the same
"clean technical" blue every time, so the pipeline's output ends up looking
identical paper-to-paper. A palette derived from *this* figure's subject makes
each figure recognisably its own — which is the whole point of the phase.

Two things are non-negotiable — they are what separate a publication-grade
figure from an amateur one. **Everything else is yours to design**, and you
should vary it from figure to figure.

### Guardrails (always hold these)

- **Never draw.io defaults** — not the stock `#dae8fc` fill, never a black
  outline.
- **Every fill carries a contrast-safe font, derived not eyeballed:** a *dark
  tint of the fill's own hue* on any light fill; *white* on a saturated fill.
  Never light-on-light, never a muddy mid-tone on a mid-tone.
- **White / transparent canvas**, one sans-serif font throughout (§5), and the
  semantic solid-vs-dashed edge split (§4).
- **One coherent palette for the whole figure, with a clear visual
  hierarchy:** backgrounds recede, the result/output element dominates, and
  every role is distinct enough to tell apart at a glance. If everything reads
  at the same weight, the figure has failed regardless of the colors.

### Design decisions (vary these across figures)

1. **Anchor hue — from the figure, not a reflex.** Choose one anchor hue
   motivated by something specific to *this* paper: its subject / modality
   (audio, molecules, robotics, language, retrieval, 3D geometry, graphs,
   diffusion, RL, …), the method's own metaphor or "brand," or the colors in
   the paper's own figures if it has them. Write the reason down (it becomes
   the rationale line in `style.md`). **Do not reflexively reach for
   blue/slate because the content is "technical ML"** — almost everything here
   is, so that reflex is exactly what makes every figure look the same. Blue is
   fine only when the figure's *subject* (not its genre) genuinely calls for
   it, and you say why.

2. **Value strategy — how you build the hierarchy.** The most common approach
   is *light-key*: very light desaturated zones, medium-pastel modules, and a
   single saturated accent. It's a safe default — but it is **not the only
   option**, and defaulting to it every time is its own kind of sameness. A
   near-monochrome + one accent, a two-hue duotone, a darker "hero" zone with
   light modules floating on it, or content-driven saturated coding (per-channel
   RGB, per-agent / per-expert colors, a spectrum) are all legitimate when the
   figure calls for them. Pick the strategy that fits the content, then keep it
   consistent across panels.

   *Typical ranges for a light-key figure* (targets, not mandates — a duotone
   or dark-hero figure will differ): zones lightness ~92–96% & low saturation;
   modules ~82–90% & moderate saturation; neutral a near-gray ~92–94% with a
   whisper of the anchor hue; the accent mid-lightness (~40–60%) & high chroma,
   reserved for one element; edges a dark desaturated anchor ~30–45%.

3. **Roles — name the color roles this figure needs.** A typical, adaptable set:

   | role | what it colors |
   |---|---|
   | zone | grouping containers / stage backgrounds |
   | module (warm / cool) | process blocks — a warm/cool split *optionally* encodes trainable vs frozen |
   | neutral | generic boxes with no special meaning |
   | accent | the output / loss / result you want the eye to land on |
   | edges | arrows / connectors |

   Use the warm/cool split when the figure has a trainable-vs-frozen (or
   active-vs-static) distinction worth showing; drop it when it doesn't. Skip
   roles you don't need, and add one if the figure has a category the reader
   must track. Whatever set you choose, record concrete hexes for each in
   `style.md` so the panels share one vocabulary.

4. **Build the harmony.** Neighbours of the anchor (analogous, ±~30°) for the
   receding / cool roles; a warmer counterpoint (split-complementary, roughly
   +150–210°) for the active role; a contrasting high-chroma accent (often the
   anchor's complement, or a vivid secondary). The colors should visibly belong
   together.

### Anchor hues worth reaching for (a spectrum, not a shortlist)

teal / aqua (signal, audio, fluids) · forest / moss (biology, ecology,
organic) · plum / violet (language, reasoning, generative) · terracotta /
amber (robotics, embodied, warmth) · rose / magenta (attention, saliency) ·
indigo / slate (only when the subject is genuinely spatial / technical) ·
gold / sand (theory, optimization, minimalist). Pick by subject, and vary
across papers — two different figures should rarely land on the same anchor.

---

## 3. Shapes & geometry (semantic — usually fixed by Phase 1)

- **Process / module nodes:** rounded rectangle (`rounded=1;arcSize=8`).
- **Data / tensors / matrices:** sharp rectangle (`rounded=0`).
- **Databases / buffers / memory:** cylinder.
- Keep the rounded-vs-sharp distinction consistent: it encodes
  process-vs-data, so don't round data boxes or sharpen process boxes for
  looks. (These meanings are assigned in planning; the Style phase colors
  them, it doesn't reshape them.)

---

## 4. Lines & arrows

- Stroke color comes from the palette's **edge** color, never black default.
  (The per-panel Python still owns the exact hex via a placeholder for the
  crossing check — the Style phase just names which color.)
- Also name **2–3 secondary edge colors** for arrows that must cross. The
  crossing check rejects same-colored intersecting edges outright, so a
  palette with one edge color makes every unavoidable crossing a hard
  failure in Phase 2. These are a role-free pool, not semantic roles: the
  two edges of a crossing pair may take two different pool colors even
  when they mean the same thing (meaning lives in solid/dashed and the
  label, not the hue).
- `strokeWidth=3` so arrows survive downscaling into a paper column.
- **Solid** = forward data flow. **Dashed** (`dashed=1;dashPattern=4 2`) =
  auxiliary flow (gradients, skip/feedback, loss). This solid/dashed split
  is semantic — keep it.
- Reserve the **accent** color for the arrow/box that carries the result or
  loss, so the eye lands there first.

---

## 5. Typography

- **Labels:** one sans-serif family throughout (`fontFamily=Helvetica`).
  Bold for headers/module names, regular for details.
- **Math:** MathJax via `$$...$$` (renders serif/italic natively) — keep to
  the 2–3-formula budget from `panel_agent.md`.
- **Font sizes:** a small fixed set — title/header ~18, standard label 14
  (the legibility floor), fine annotation ~12. Do not scatter many
  distinct sizes; inconsistent sizing looks unprofessional and is harder
  to read.

---

## 6. Domain vibes (anchor-hue starting points, not fixed answers)

- **Agent / LLM / language:** illustrative and friendlier — warmer anchors
  (plum, violet, terracotta), chat / document motifs as *shapes* (not emoji).
- **Vision / 3D / geometry:** spatial and geometric; cool anchors (teal,
  indigo, slate) read well and RGB channel / axis color coding is
  conventional — but a vision paper is not *required* to be blue.
- **Theory / optimization:** minimalist, restrained — a near-grayscale
  palette with a single warm highlight (gold / amber), few colors.
- **Biology / chemistry / science:** organic anchors (forest, moss, sage).
- **Audio / signal / physics:** teal / aqua or a spectral anchor.

Treat these as first ideas to react against, not a lookup table — the goal is
that two different papers rarely land on the same anchor.

---

## 7. What the Style phase records in `style.md`

A concrete, figure-wide spec the panels can apply verbatim: the **anchor hue,
value strategy, and one-line rationale** (why this palette for this figure);
the role→fill+font hex table (one row per role the figure uses — §2, decision
3); the edge color and stroke rules; the corner
convention; the font family and size set; which element carries the reserved
accent; and any per-panel emphasis notes (what should draw the eye first in
each panel). See `prompts/phase1b-style.md` for the exact output contract.

Cross-references: `references/template_authoring.md` (how style strings go
into the drawio XML), `references/panel_agent.md` (how panels consume
`style.md`).
