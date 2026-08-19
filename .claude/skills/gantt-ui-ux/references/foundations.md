# UI/UX Foundations

## Core Definitions

- **UI (User Interface)**: the surface — pixels, controls, layout, canvas draw calls, DOM overlay elements. What the user touches/sees.
- **UX (User Experience)**: the full outcome of using the product — comprehension, efficiency, error recovery, emotional response. UI is one input to UX; performance, information architecture, and feedback timing are others.
- **Usability**: can users accomplish tasks effectively, efficiently, and with satisfaction? (ISO 9241-11: effectiveness, efficiency, satisfaction, in a specified context of use.)
- **Utility**: does the feature do something users actually need? A perfectly usable feature nobody needs has zero UX value. Usability × Utility = Usefulness (Nielsen).
- **Interaction design**: shaping *behavior over time* — what happens on hover, click, drag, keypress; the state machine between user intent and system response. For a gantt library this is the dominant discipline: task bars, dependency lines, tree rows are all interaction surfaces, not static graphics.
- **Direct manipulation** (Shneiderman): users act on visible objects (drag a bar to reschedule) rather than issuing commands through separate controls — the reason gantt charts favor drag-to-edit over dialog-driven date entry.

## Nielsen's 10 Usability Heuristics

Apply to every dialog, tooltip, context menu:

1. **Visibility of system status** — show drag state, loading, save/undo progress within latency budgets (see `performance-ux.md`).
2. **Match between system and the real world** — dates, durations, dependency terms should read like project-management language, not internal data-model terms.
3. **User control and freedom** — every destructive/structural action needs an "emergency exit": Esc cancels an in-progress drag; undo reverses committed transactions.
4. **Consistency and standards** — one resize-handle style, one selection-highlight color, one keyboard scheme across the whole chart. Don't reinvent scrollbar or resize affordances OS/browser conventions established.
5. **Error prevention** — snapping, constraint validation (end ≥ start), confirmation for irreversible bulk deletes.
6. **Recognition rather than recall** — visible today-line, visible dependency arrows, visible current zoom level; don't make users remember unrendered state.
7. **Flexibility and efficiency of use** — keyboard shortcuts and multi-select for power users; simple click-drag for novices.
8. **Aesthetic and minimalist design** — every pixel in a 10k-row dense chart competes for attention; suppress non-essential chrome.
9. **Help users recognize, diagnose, and recover from errors** — inline validation messages near the offending bar/cell, plain language, concrete fix ("End date can't precede start date").
10. **Help and documentation** — for a library, this maps to good default tooltips/aria-labels rather than a manual.

## Laws & Principles

- **Fitts's Law**: time to acquire a target = f(distance, size). Resize handles and drag hotspots need real hit area (≥24×24px), not just a 1px visual edge. Put frequent controls (zoom, today button) near where the eye already is.
- **Hick's Law**: decision time grows with number/complexity of choices. Context menus ≤7–9 items, grouped by frequency, progressive disclosure for advanced options ("More actions ▸").
- **Gestalt principles**:
  - *Proximity*: task label and its bar must read as one unit; padding between unrelated rows > padding within a row.
  - *Similarity*: same task type (milestone, summary, normal) always renders with the same shape/color coding.
  - *Continuity*: dependency arrows should route to visually continue the left-to-right flow.
  - *Common region*: tree-grid pane and chart pane need a shared row-height/gridline system so a row reads as one region across the split.
  - *Figure/ground*: task bars (figure) must contrast against timeline background (ground) — weekend shading and today-line are ground, never outweighing bars in contrast.
- **Jakob's Law**: users transfer expectations from other apps (MS Project, Excel, Jira, Asana). Default to their conventions: drag edge to resize duration, drag body to move, connector dot to draw dependencies, wheel + modifier to zoom.
- **Progressive disclosure**: show start/end/duration/assignee inline; push allocation %, custom fields, cost into an expandable panel or popover.
- **Norman's affordance / signifier / feedback**:
  - *Affordance*: what an object allows (a bar edge can be grabbed).
  - *Signifier*: the cue communicating it (cursor `ew-resize`, handle appears on hover).
  - *Feedback*: the response (bar stretches live during drag, ghost preview shows drop position).
  - Rule: **no invisible affordances** — if a row can be dragged to reorder, something must signify it before the user touches it (grip icon on hover); cursor change alone is not enough on canvas, where cursor CSS needs manual hit-testing.
