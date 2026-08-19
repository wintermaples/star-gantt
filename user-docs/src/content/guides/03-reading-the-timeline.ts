import type { GuideDoc } from "../types";

/**
 * Where the chart opens and why. Kept to the two settings a reader actually touches — origin and
 * zoom — plus the reference lines and the weekend shading they will notice immediately.
 */
const doc: GuideDoc = {
  slug: "reading-the-timeline",
  title: "Reading the timeline",
  lede: "A chart opens on a few weeks out of a much longer axis. Two settings decide which few weeks, and one of them catches everybody out.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "Where a chart opens has nothing to do with your data. Two settings decide it: the origin, which is what sits at the left edge, and the zoom level, which is how wide a day is.",
        "The default origin is today. If your project starts next month, the chart opens on empty grid — correctly, but on empty grid. That is the single most common reason a new chart looks broken.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {},
}`,
      caption: 'the default: origin today, zoom "day" — the sample project starts today, so it opens on its content',
    },
    {
      kind: "prose",
      paragraphs: [
        "Set `view.timeline.origin` to fix it. It takes an epoch-millisecond instant; a few days before your earliest task is usually right.",
        "Round it to a whole day. An origin in the middle of a day puts every day boundary on a half pixel and the header lines go fuzzy.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { timeline: { origin: Math.floor(Date.now() / 86_400_000) * 86_400_000 - 3 * 86_400_000 } },
  },
}`,
      caption: "origin pulled back three days, so the project opens with a little runway",
    },
    {
      kind: "prose",
      paragraphs: [
        'The zoom level sets how much time fits on screen. `view.timeline.initialZoom` picks the one a chart opens at: "hour", "day", "week", "month", "quarter" or "year".',
        "A name that is not one of those is ignored and you get the first level instead — with no warning, so check the spelling before looking elsewhere.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: {
      timeline: {
        origin: Math.floor(Date.now() / 86_400_000) * 86_400_000 - 3 * 86_400_000,
        initialZoom: "month",
      },
    },
  },
}`,
      caption: "same data at month zoom — the whole release fits without scrolling",
    },
    {
      kind: "prose",
      paragraphs: [
        "Scrolling and zooming never move the origin. Zooming keeps whatever is under your pointer in place, so the chart does not jump around as you go. Scroll the timeline sideways with a horizontal wheel or trackpad gesture, or by holding Shift while you scroll.",
        "If the axis really has shifted, something called `setOrigin` — a zoom gesture cannot do it. The one other thing that moves it is `view.timeline.autoExtendOrigin`, which lets the chart begin earlier than its `origin` while the data (or a bar being dragged) reaches back further, and returns to `origin` when nothing does.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "Two vertical lines sit on top of the grid. The solid one is today and needs no setting up. The dashed one is the status date — the date you are measuring progress against, which is often not today — and you turn it on by naming it.",
        "Both are just lines at a date. If you have scrolled away from that date, there is nothing to see, and nothing is wrong.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: {
      timeline: { origin: Math.floor(Date.now() / 86_400_000) * 86_400_000 - 3 * 86_400_000 },
      todayLine: { statusDate: Date.now() + 10 * 86_400_000 },
    },
  },
}`,
      caption: "solid today line, dashed status line ten days ahead of it",
    },
    {
      kind: "prose",
      paragraphs: [
        "Weekends are shaded behind the bars, faintly on purpose — enough to see a bar span one, not enough to compete with it.",
        "Without a working calendar that means Saturday and Sunday. Configure `scheduling.calendars` and name that calendar in `gridLines.nonWorkingDays.calendar` and it means your actual holidays instead, drawn exactly the same way.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: {
      timeline: { origin: Math.floor(Date.now() / 86_400_000) * 86_400_000 - 3 * 86_400_000 },
      gridLines: { nonWorkingDays: false },
    },
  },
}`,
      caption: "shading off — a weekend and a working day now look the same",
    },
    {
      kind: "callout",
      tone: "warn",
      body: "A chart that opens looking empty is nearly always on the right axis and the wrong part of it. Check origin against your data's first date before assuming anything is broken.",
    },
  ],
  next: ["/reference/view", "/reference/view/config", "/reference/scheduling"],
};

export default doc;
