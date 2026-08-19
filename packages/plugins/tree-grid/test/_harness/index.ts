/**
 * The DOM harness this package's tests are written against.
 *
 * Test-only: nothing here is imported from `src/`, and nothing here enters a bundle. It stands in
 * for a real browser DOM and a real canvas 2D context with recording doubles, so a test can assert
 * exactly which DOM calls a plugin makes and exactly what it paints.
 */
export { FakeContext2D, FakeGradient } from "./dom-canvas";
export type { DrawnImage, Line, Op, TextOp } from "./dom-canvas";

export { FakeElement, FakeInput } from "./dom-element";
export type { ClientRect, Handler, Rect } from "./dom-element";

export { FakeCanvas, FakeDocument } from "./dom-document";
export type { CanvasOptions, ObserverRecord } from "./dom-document";

export { asContext, asElement, installDom } from "./dom-install";
export type { DomHarness, DomOptions, MediaQueryDouble } from "./dom-install";

export { fakePluginContext, flatTasks } from "./stubs";
export type { ContextLog, FakeContext, FakeContextOptions } from "./stubs";

export { declaredStyle, publishInlineCustomProperties, safeArea, slotBox } from "./slot-geometry";
export type { PaneBox, SafeArea, SlotBox } from "./slot-geometry";
