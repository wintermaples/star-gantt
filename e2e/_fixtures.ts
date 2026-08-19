import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

// Shared E2E fixtures: a single boot path (`openExample`) that always installs the page-error
// listener first, and the two-rAF `settle()` helper a screenshot needs before it captures a fully
// painted, quiescent frame. A `settleLayout` helper that waits out a transient one-frame
// grid/canvas height disagreement is not implemented yet — that disagreement only appears once
// the bottom-region plugins (not yet implemented) reserve space; add the helper back when that
// lands.
//
// The suite's E2E policy is unchanged (docs/specs/architecture.md distribution chapter): tests
// open the pages under `examples/`, which load the built IIFE bundle. No test-only HTML exists.

/**
 * The instant clock-pinning specs freeze `Date.now()` at, shared so every screenshot/DOM
 * measurement in one test run is taken against the same calendar day.
 *
 * `examples/basic.html` builds its data relative to "today" (docs/specs/architecture.md §6.2 —
 * the time axis origin defaults to today 0:00 UTC) and the axis header prints real calendar
 * dates, so an unpinned clock would change every run. Only the date is faked; timers and rAF stay
 * real, so rendering itself is unaffected. The instant is fixed once here so it stays consistent
 * with the baseline images in `readonly.spec.ts-snapshots/` — see readonly.spec.ts's header for
 * how those baselines are generated.
 */
export const FIXED_TIME = new Date("2026-08-07T12:00:00Z");

/**
 * Waits two animation frames.
 *
 * The view plugin composites its layers (and repositions DOM-overlay wrappers) in a single
 * once-per-rAF pass, so one frame turn guarantees the pass has run for work queued before the
 * call and the second guarantees the resulting paint has been flushed.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

/** Starts collecting uncaught page exceptions from `page`, returning the live list. */
export function watchPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  return errors;
}

/** Asserts a `watchPageErrors()` list is empty, naming each error so a failure is readable. */
export function expectNoPageErrors(errors: readonly Error[]): void {
  expect(
    errors.map((error) => `${error.name}: ${error.message}`),
    "uncaught page errors",
  ).toEqual([]);
}

export interface OpenExampleOptions {
  /**
   * Selector whose first match must become visible before the page counts as booted. Defaults to
   * `"canvas"` — the view plugin's layers, i.e. "the chart has mounted". Pass `null` for a page
   * whose readiness the spec checks itself.
   */
  ready?: string | null;
  /** Pins `Date.now()` to this instant *before* navigation. Omitted, the real clock is used. */
  fixedTime?: Date;
  /** Waits {@link settle} after the ready condition — required before a screenshot. */
  settle?: boolean;
}

/**
 * Opens an example page. The argument is a file name under `examples/` (`"basic.html"`); a value
 * starting with `/` is used as the URL verbatim.
 */
export type OpenExample = (example: string, options?: OpenExampleOptions) => Promise<void>;

interface Fixtures {
  /** Uncaught page exceptions seen so far, asserted empty at teardown. */
  pageErrors: Error[];
  openExample: OpenExample;
}

export const test = base.extend<Fixtures>({
  pageErrors: [
    async ({ page }, use) => {
      const errors = watchPageErrors(page);
      await use(errors);
      // Teardown, so a page exception thrown *after* the last assertion still fails the test.
      expectNoPageErrors(errors);
    },
    // `auto` so no spec can silently skip the collection.
    { auto: true },
  ],

  openExample: async ({ page, pageErrors }, use) => {
    // Requested explicitly, not merely relied upon through `auto`, so the listener is provably
    // installed before this fixture's first navigation.
    void pageErrors;
    await use(async (example, options = {}) => {
      const url = example.startsWith("/") ? example : `/examples/${example}`;
      if (options.fixedTime !== undefined) await page.clock.setFixedTime(options.fixedTime);
      await page.goto(url);
      const ready = options.ready === undefined ? "canvas" : options.ready;
      if (ready !== null) await expect(page.locator(ready).first()).toBeVisible();
      if (options.settle === true) await settle(page);
    });
  },
});

export { expect };
