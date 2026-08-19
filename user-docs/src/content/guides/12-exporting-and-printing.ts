import type { GuideDoc } from "../types";

/**
 * Image, document, share link — all one plugin, `export`, already in the standard preset. Every
 * cell still mounts a live chart — this site has no surface to display an exported file on, so
 * the export calls are made for real and their results logged. The PDF size arithmetic and the
 * exact veto semantics live on the reference page.
 */
const doc: GuideDoc = {
  slug: "exporting-and-printing",
  title: "Exporting and printing",
  lede: "Getting a chart out of the browser: as an image, as a printable document, or as a read-only link. One plugin, and one thing it cannot carry.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "Read this first, because it surprises everybody: the task list on the left is not part of an exported image. Only the timeline and the bars are.",
        "That is not a bug to chase. If you need the names on the page, use the print config, which draws its own table.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "`export` is already in the standard preset, and its `image` config nest covers picture output. Call `toPng()` or `toSvg()` on the export service and you get a blob (or, for SVG, markup) back; `toPng({ format: \"jpeg\" })` is the JPEG path.",
        'The setting worth changing is `range`. By default you get exactly what is on screen, cropped wherever the scrollbars happen to be. Set `range: "full"` for the whole project — that is what you want for anything you are handing to someone else.',
        "`pixelRatio: 2` gives you a crisp image for print. `background` paints a solid colour behind everything, which JPEG needs — without it a JPEG comes out with a white background.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    export: { image: { range: "full", background: "#fff", pixelRatio: 2 } },
  },
}`,
      caption: "the print-quality configuration: every task, an opaque background, double resolution",
    },
    {
      kind: "runnable",
      source: `{
  height: 340,
  plugins: (sg) => [
    // The exact calls a "download as PNG" button would make. There is no surface on this page
    // to show an exported bitmap, so the cell logs what came back instead.
    sg.definePlugin({
      meta: { id: "guide.export-image-call", dependsOn: ["stargantt.data-store", "stargantt.export"] },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        const off = data.tasks.subscribe(async () => {
          off.dispose();
          try {
            const exportService = ctx.use("stargantt.export");
            const png = await exportService.toPng();
            console.log(\`toPng() produced a \${png.type} blob, \${png.size} bytes\`);
            const svg = await exportService.toSvg();
            console.log(\`toSvg() produced \${svg.length} characters of markup\`);
          } catch {
            // The chart can be torn down mid-export; a real button would guard the same way.
          }
        });
        ctx.own(off);
      },
    }),
  ],
}`,
      height: 340,
      caption: "the real calls, against the live chart — check the browser console for what they returned",
    },
    {
      kind: "code",
      caption: "saving the result — the SDK's downloadFile is the shared object-URL/<a download>/revoke helper every export method's caller uses",
      source: `import { downloadFile } from "@stargantt/sdk";

const exportService = gantt.service("stargantt.export");
const png = await exportService.toPng({ range: "full" });
downloadFile(document, png, "gantt.png", "image/png");`,
    },
    {
      kind: "prose",
      paragraphs: [
        "Some things below the chart do make it into an export. The load chart's team band is one of them, even though it is not drawn on the canvas.",
        "The per-person lanes are not. If something appears on screen and not in your export, that is why.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  height: 380,
  plugins: (sg) => [
    sg.resource({
      pool: {
        resources: [
          { id: "alice", name: "Alice", capacity: 1 },
          { id: "bob", name: "Bob", capacity: 1 },
        ],
        syncToStore: true,
      },
      loadChart: { total: true, axisLabels: true },
    }),
    sg.definePlugin({
      meta: {
        id: "guide.export-seed-load",
        dependsOn: ["stargantt.data-store", "stargantt.resource"],
      },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        const off = data.tasks.subscribe(() => {
          off.dispose();
          // A data-store subscriber may not dispatch synchronously — defer one microtask.
          queueMicrotask(() => {
            ctx.dispatch("assignment/set", { taskId: "wire", resourceId: "alice", units: 1 });
            ctx.dispatch("assignment/set", { taskId: "visual", resourceId: "bob", units: 1 });
          });
        });
        ctx.own(off);
      },
    }),
  ],
}`,
      height: 380,
      caption: "the band under the chart is drawn in HTML, and still appears in an export",
    },
    {
      kind: "prose",
      paragraphs: [
        "`print`, another nest, produces a paginated document instead of one picture. Paper size, orientation, margins, headers and which columns repeat on every page are all settings.",
        "`printPreview()` shows the pages on screen; `toPdf()` writes a file. Check `pageCount()` first — it does the layout without drawing anything, so it is cheap.",
        "For anything longer than a few pages, prefer the preview and your browser's own print-to-PDF. The built-in PDF is a picture of the chart: large, and with no selectable text.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  height: 380,
  plugins: (sg) => [
    sg.definePlugin({
      meta: {
        id: "guide.export-print-preview",
        dependsOn: ["stargantt.export", "stargantt.data-store"],
      },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        // Opens the real preview once the data has loaded — a preview of an empty chart is one
        // blank page.
        const off = data.tasks.subscribe(() => {
          off.dispose();
          const opened = ctx.use("stargantt.export").printPreview({
            paper: "a4",
            orientation: "landscape",
            header: { left: "Release plan" },
          });
          if (!opened) {
            console.warn("printPreview() returned false — no preview was opened");
          }
        });
        ctx.own(off);
      },
    }),
  ],
}`,
      height: 380,
      caption: "the print preview, opened on load — the same pages `toPdf()` would write",
    },
    {
      kind: "prose",
      paragraphs: [
        "`viewerEmbed` does not make a file at all. It makes the chart read-only, so you can show it to people who should not change it.",
        "`snapshot()` packs the whole project into a string you can put in a URL, and the receiving page can restore it with `applySnapshot()` — no server involved. The link is the data.",
        "Below, an edit is attempted the moment the data loads. Nothing happens — read-only means the edit is dropped silently.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    export: { viewerEmbed: { readOnly: true } },
  },
  plugins: (sg) => [
    // Try one real edit. "wire" starts with a full progress bar; watch it stay that way.
    sg.definePlugin({
      meta: { id: "guide.export-attempt-edit-blocked", dependsOn: ["stargantt.data-store"] },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        const off = data.tasks.subscribe(() => {
          off.dispose();
          queueMicrotask(() => {
            ctx.dispatch("task/update", { id: "wire", after: { progress: 0 }, origin: "my-sync-plugin" });
          });
        });
        ctx.own(off);
      },
    }),
  ],
}`,
      caption: 'read-only — the edit is dropped, and "wire" stays full',
    },
    {
      kind: "prose",
      paragraphs: [
        "A read-only chart usually still needs to receive updates from your own code. List the origins that are allowed through and they are.",
        "The same edit as above now lands, because its origin is on the list.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    export: { viewerEmbed: { readOnly: true, readOnlyExemptOrigins: ["my-sync-plugin"] } },
  },
  plugins: (sg) => [
    // Identical dispatch — only the plugin's config changed.
    sg.definePlugin({
      meta: { id: "guide.export-attempt-edit-exempt", dependsOn: ["stargantt.data-store"] },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        const off = data.tasks.subscribe(() => {
          off.dispose();
          queueMicrotask(() => {
            ctx.dispatch("task/update", { id: "wire", after: { progress: 0 }, origin: "my-sync-plugin" });
          });
        });
        ctx.own(off);
      },
    }),
  ],
}`,
      caption: 'the same edit, now on the exempt list — it lands, and "wire" empties out',
    },
    {
      kind: "callout",
      tone: "warn",
      body: "Those origin names are matched exactly, and a wrong one fails silently — the feed you meant to let through is blocked like any other edit. Copy the string from the plugin that sends it rather than typing it from memory. Origins beginning with `stargantt.data-sync/` are exempt automatically — that is the `dataSync` plugin's own machine writes, not something you configure here.",
    },
  ],
  next: [
    "/reference/export",
    "/reference/export/config",
    "/guides/resources-and-workload",
  ],
};

export default doc;
