/**
 * The DOM harness this package's tests are written against.
 *
 * Test-only: nothing here enters the bundle. Trimmed to the parts the view tests use — this
 * package keeps its test doubles inside the package that needs them (the precedent
 * `packages/sdk/test/_dom.ts` sets), so no shared harness package exists to import from.
 *
 * The canvas doubles record drawing operations, which is what lets the paint passes be asserted
 * without a real canvas; `happy-dom` provides no 2d context, so it cannot stand in here.
 */
export {
  DEFAULT_POINTER_ID,
  FakeCanvas,
  FakeContext2D,
  FakeDocument,
  FakeElement,
  FakeGradient,
  FakeInput,
  asCanvas,
  asContext,
  asDocument,
  asElement,
  asKeyboardEvent,
  asPointerEvent,
  fakeView,
  installDom,
  keyEvent,
  pointerEvent,
  wheelEvent,
} from "./dom";
export type {
  CanvasOptions,
  ClientRect,
  DomHarness,
  DomOptions,
  DrawnImage,
  EventDouble,
  FakeView,
  Handler,
  KeyDouble,
  Line,
  MediaQueryDouble,
  ObserverRecord,
  Op,
  PointerDouble,
  PointerInit,
  Rect,
  TextOp,
  WheelDouble,
} from "./dom";

export {
  declaredStyle,
  publishInlineCustomProperties,
  resolveCssPx,
  safeArea,
  slotBox,
  slotGeometry,
} from "./slot-geometry";
export type { PaneBox, SafeArea, SlotBox, SlotGeometry } from "./slot-geometry";
