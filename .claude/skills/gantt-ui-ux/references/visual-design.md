# Visual Design Fundamentals

## Typography

- UI chrome: 12–13px for dense grid/row text, 14px for panel/dialog text; never below 11px for real content (12px is the practical floor).
- Line-height 1.3–1.5× font size; 1.2× acceptable only for single-line dense rows with fixed row height.
- 1–2 font families max; use weight (500/600), not extra families, for emphasis (task name vs. summary task name).
- Numeric columns (dates, %, duration) use tabular figures so columns align.

## Spacing / Rhythm — 8px Grid

- Base unit 8px (4px half-step for icon padding). Row height, column padding, icon sizes as multiples of 4/8.
- Scale: 4 / 8 / 12 / 16 / 24 / 32px.

## Row Height

- Dense mode 24–28px, comfortable mode 32–36px.
- Must stay identical between tree-grid and canvas chart rows — a hard sync requirement; misalignment breaks the split-pane metaphor entirely.

## Color & Contrast (WCAG 2.2)

- Body text vs. background: **≥ 4.5:1** (AA); 7:1 for AAA.
- Large text (≥24px, or ≥18.66px bold) and **UI component/graphical boundaries** (task bar outline, resize handle, focus ring): **≥ 3:1**.
- Never encode meaning by hue alone — pair color with shape/pattern/label (e.g., critical path = red **and** thicker stroke **and** optional hatch).
- Weekend shading and today-line stay under ~3:1 against normal background so they read as "ground", never competing with bar "figure" contrast.

## Visual Hierarchy

- Primary: task bars and dependency lines. Secondary: gridlines/timeline scale labels. Tertiary: weekend shading/today-line.
- Encode via opacity/weight: gridlines at 8–15% opacity; today-line full saturation but thin (1–2px).

## Alignment

- Chart date ticks pixel-align with gridlines; tree-grid column edges pixel-align with vertical dividers.
- Even 1px misalignment is highly visible in a canvas grid and reads as a bug.

## Density for Data-Heavy UIs

- Default "compact but scannable": avoid whitespace that reduces rows-per-screen (scroll fatigue at 10k rows), but keep ≥4px vertical breathing room per row.
- Never let two task bars visually touch without a hairline gap.

## Viewport

- Assume width ≥ 720px, height ≥ 540px (tablet or wider). No phone layouts, no sub-720px breakpoints. Verify layouts at exactly 720×540 as the minimum case.
