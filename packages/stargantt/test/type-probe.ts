/**
 * Type-only probe against the BUILT dist declaration file, `dist/index.d.ts` — not `src/index.ts`.
 *
 * `pnpm run typecheck` (the package's own `tsc --noEmit`) and `vitest run` (`test/exports.test.ts`)
 * both resolve `@stargantt/*` workspace specifiers through node_modules symlinks to each
 * dependency's own `dist`, so they already exercise real built output for every *dependency* of
 * this package. What neither one checks is this package's *own* emitted `.d.ts` — the artifact an
 * external consumer of the published `stargantt` package actually gets. `src/index.ts` and
 * `dist/index.d.ts` are expected to agree exactly (the build's declaration step is a straight
 * `tsc --emitDeclarationOnly` over `src/index.ts`, no bundler transform in between), but that
 * agreement is exactly the kind of thing that silently breaks: a future switch to bundling
 * declarations (`vite-plugin-dts`, `rollup-plugin-dts`, …), a `tsconfig.build.json` change, or a
 * mis-set `exports`/`types` field in `package.json` would all pass every other gate while shipping
 * broken or incomplete types. This file imports the built `dist/index.d.ts` directly and never runs
 * (`tsconfig.typecheck-dist.json` is `noEmit`, and nothing else imports this file), so a compile
 * failure here means the *shipped* types are the ones missing something — not the source.
 *
 * Named after the KNOWN GAP the check exists for: `dist/index.d.ts` once shipped at 2.8KB,
 * carrying only `Gantt`/`create`/`presetStandard`/the opt-in factories' own config types and
 * dropping the rest of every opt-in plugin's public surface, plus a handful of preset-plugin
 * standalone values (`dateEditor`/`selectEditor`, `regionCalendar`, theme tokens) that have no
 * other nameable path for a `stargantt`-only consumer. This probe names one representative type
 * from each such group; `src/index.ts`'s own re-export list is the exhaustive source of truth.
 *
 * Wired into the package's `build` script (`vite build && tsc -p tsconfig.build.json && tsc -p
 * tsconfig.typecheck-dist.json`), immediately after the declaration step that produces
 * `dist/index.d.ts`, so a broken build fails loudly rather than shipping quietly.
 */
import { Gantt, create, presetStandard } from "../dist/index";
import type { PresetStandardConfig } from "../dist/index";
// Preset-plugin standalone values with no service-typed path (module-augmentation reach, file
// header) — see src/index.ts "Standalone values contributed by preset plugins".
import {
  dateEditor,
  selectEditor,
  regionCalendar,
  DEFAULT_MESSAGES,
  BUILT_IN_PRESETS,
  HIGH_CONTRAST_DARK,
  HIGH_CONTRAST_LIGHT,
  FORCED_COLOR_TOKENS,
  CANVAS_READ_TOKENS,
  NON_COLOR_CANVAS_TOKENS,
  RETIRED_TOKENS,
} from "../dist/index";
import type {
  CellRenderer,
  ColumnLayoutConfig,
  InsertPosition,
  SelectOption,
  CalendarInit,
  RegionCalendarInit,
  A11yMessages,
  GridCell,
  ZoomLevelMetrics,
  ColorScheme,
  PresetTokens,
  SetPresetOptions,
  ThemeAuditEntry,
  ThemePreset,
} from "../dist/index";
// Opt-in plugins: factory + config type (already covered above the fold in src/index.ts) plus one
// representative type from deeper in each package's own surface, which is reachable from a
// `stargantt`-only program only because src/index.ts re-exports it in full.
import {
  tracking,
  resource,
  dataSync,
  restAdapter,
  localAdapter,
  graphqlAdapter,
  webSocketTransport,
  sseTransport,
  portfolio,
  i18n,
  createDictionary,
  perfTools,
} from "../dist/index";
import type {
  TrackingConfig,
  BaselinesService,
  CostService,
  EvmService,
  ProgressService,
  ResourceConfig,
  ResourcePoolService,
  UtilizationService,
  UtilizationReportRow,
  DataSyncConfig,
  DataSyncService,
  RealtimeTransport,
  GraphqlAdapterConfig,
  PortfolioConfig,
  PortfolioService,
  DashboardModel,
  I18nConfig,
  I18nService,
  TranslationEntries,
  PerfToolsConfig,
  PerfToolsService,
  FrameStats,
} from "../dist/index";

/** Compile-time-only check: never called, just keeps every import above "used". */
function _typeSurfaceCheck(args: {
  preset: PresetStandardConfig;
  cellRenderer: CellRenderer;
  columnLayout: ColumnLayoutConfig;
  insertPosition: InsertPosition;
  selectOption: SelectOption;
  calendarInit: CalendarInit;
  regionCalendarInit: RegionCalendarInit;
  a11yMessages: A11yMessages;
  gridCell: GridCell;
  zoomLevelMetrics: ZoomLevelMetrics;
  colorScheme: ColorScheme;
  presetTokens: PresetTokens;
  setPresetOptions: SetPresetOptions;
  themeAuditEntry: ThemeAuditEntry;
  themePreset: ThemePreset;
  trackingConfig: TrackingConfig;
  baselinesService: BaselinesService;
  costService: CostService;
  evmService: EvmService;
  progressService: ProgressService;
  resourceConfig: ResourceConfig;
  resourcePoolService: ResourcePoolService;
  utilizationService: UtilizationService;
  utilizationReportRow: UtilizationReportRow;
  dataSyncConfig: DataSyncConfig;
  dataSyncService: DataSyncService;
  realtimeTransport: RealtimeTransport;
  graphqlAdapterConfig: GraphqlAdapterConfig;
  portfolioConfig: PortfolioConfig;
  portfolioService: PortfolioService;
  dashboardModel: DashboardModel;
  i18nConfig: I18nConfig;
  i18nService: I18nService;
  translationEntries: TranslationEntries;
  perfToolsConfig: PerfToolsConfig;
  perfToolsService: PerfToolsService;
  frameStats: FrameStats;
}): typeof args {
  return args;
}
void _typeSurfaceCheck;

/** Compile-time-only check that every value export is still a callable/nameable symbol. */
function _valueSurfaceCheck(): unknown[] {
  return [
    Gantt,
    create,
    presetStandard(),
    dateEditor(),
    selectEditor([]),
    regionCalendar({ id: "custom" }),
    DEFAULT_MESSAGES,
    BUILT_IN_PRESETS,
    HIGH_CONTRAST_DARK,
    HIGH_CONTRAST_LIGHT,
    FORCED_COLOR_TOKENS,
    CANVAS_READ_TOKENS,
    NON_COLOR_CANVAS_TOKENS,
    RETIRED_TOKENS,
    tracking(),
    resource(),
    dataSync(),
    restAdapter,
    localAdapter,
    graphqlAdapter,
    webSocketTransport,
    sseTransport,
    portfolio(),
    i18n(),
    createDictionary(),
    perfTools(),
  ];
}
void _valueSurfaceCheck;
