// docs/specs/plugins/data-sync.md §2.7
/**
 * The generic REST adapter: maps the `DataSourceAdapter` interface onto three conventional JSON
 * endpoints (load / delta / batch). Hostless — the fetch implementation is injectable.
 */
import type {
  ChangeBatch,
  DataSourceAdapter,
  DataSourceFilter,
  DeltaRequest,
  DeltaResult,
  FetchRequest,
  FetchResult,
  PushResult,
  RestAdapterConfig,
} from "../../types";

const DEFAULTS = { load: "/tasks", delta: "/tasks/delta", batch: "/tasks/batch" } as const;

function resolveHeaders(config: RestAdapterConfig): Record<string, string> {
  const h = config.headers;
  if (typeof h === "function") {
    const built = h();
    return built !== null && typeof built === "object" ? built : {};
  }
  return h !== null && typeof h === "object" ? { ...h } : {};
}

/** Serializes the filter into URL query parameters: `q` (text) and `filter` (criteria as JSON). */
export function filterParams(filter: DataSourceFilter | undefined): URLSearchParams {
  const params = new URLSearchParams();
  if (filter === undefined || filter === null) return params;
  if (typeof filter.query === "string" && filter.query.trim() !== "") params.set("q", filter.query);
  if (filter.criteria !== undefined && filter.criteria !== null) {
    try {
      params.set("filter", JSON.stringify(filter.criteria));
    } catch {
      // Non-serializable criteria are dropped — an unusable value is silently ignored.
    }
  }
  return params;
}

function buildUrl(base: string, path: string, params?: URLSearchParams): string {
  const qs = params !== undefined && [...params.keys()].length > 0 ? `?${params.toString()}` : "";
  return `${base}${path}${qs}`;
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`stargantt: data-sync HTTP ${response.status}`);
  return response.json();
}

/**
 * Normalizes a load response body into a `FetchResult`, or `undefined` when the body is
 * unusable: not an array, and (as an object) missing the `tasks` key entirely. This distinguishes
 * a malformed body from a legitimately empty snapshot (`{ tasks: [] }`).
 */
function normalizeFetchResult(body: unknown): FetchResult | undefined {
  if (Array.isArray(body)) return { tasks: body };
  if (body === null || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.tasks)) return undefined;
  const result: FetchResult = { tasks: record.tasks };
  if (Array.isArray(record.links)) result.links = record.links;
  if (Array.isArray(record.resources)) result.resources = record.resources;
  if (Array.isArray(record.assignments)) result.assignments = record.assignments;
  if (typeof record.syncToken === "string") result.syncToken = record.syncToken;
  return result;
}

/**
 * Creates a `DataSourceAdapter` over a conventional REST backend (§2.7). `fetch` issues
 * `GET {baseUrl}{endpoints.load}` (filter as `q`/`filter` query parameters) and accepts either a
 * bare task array or a `{ tasks, links?, resources?, assignments?, syncToken? }` object.
 * `fetchDelta` issues `GET {endpoints.delta}?since={syncToken}` expecting
 * `{ changes, syncToken }`. `push` issues `POST {endpoints.batch}` with the JSON batch body,
 * accepting an optional `{ syncToken }` reply. Setting an endpoint to `null` removes that
 * capability from the returned adapter. A non-2xx status rejects with an `Error`. Every request's
 * `signal` (when given) rides on the `fetch` `RequestInit` (§1 abort machinery).
 */
export function restAdapter(config?: RestAdapterConfig): DataSourceAdapter {
  const cfg = config !== null && typeof config === "object" ? config : {};
  const base = typeof cfg.baseUrl === "string" ? cfg.baseUrl.replace(/\/$/, "") : "";
  const ep = cfg.endpoints !== null && typeof cfg.endpoints === "object" ? cfg.endpoints : {};
  const loadPath = typeof ep.load === "string" ? ep.load : DEFAULTS.load;
  const deltaPath = ep.delta === null ? null : typeof ep.delta === "string" ? ep.delta : DEFAULTS.delta;
  const batchPath = ep.batch === null ? null : typeof ep.batch === "string" ? ep.batch : DEFAULTS.batch;
  const doFetch: (input: string, init?: RequestInit) => Promise<Response> =
    typeof cfg.fetch === "function" ? cfg.fetch : (...args) => globalThis.fetch(...args);

  const adapter: DataSourceAdapter = {
    async fetch(request: FetchRequest): Promise<FetchResult> {
      const response = await doFetch(buildUrl(base, loadPath, filterParams(request?.filter)), {
        method: "GET",
        headers: resolveHeaders(cfg),
        ...(request?.signal !== undefined ? { signal: request.signal } : {}),
      });
      const normalized = normalizeFetchResult(await readJson(response));
      if (normalized === undefined) {
        throw new Error("stargantt: data-sync adapter received a malformed load response (no usable task list)");
      }
      return normalized;
    },
  };

  if (deltaPath !== null) {
    adapter.fetchDelta = async (request: DeltaRequest): Promise<DeltaResult> => {
      const params = filterParams(request?.filter);
      params.set("since", request.syncToken);
      const response = await doFetch(buildUrl(base, deltaPath, params), {
        method: "GET",
        headers: resolveHeaders(cfg),
        ...(request?.signal !== undefined ? { signal: request.signal } : {}),
      });
      const body = (await readJson(response)) as Partial<DeltaResult> | null;
      return {
        changes: Array.isArray(body?.changes) ? body.changes : [],
        syncToken: typeof body?.syncToken === "string" ? body.syncToken : request.syncToken,
      };
    };
  }

  if (batchPath !== null) {
    adapter.push = async (batch: ChangeBatch, request?: { signal?: AbortSignal }): Promise<PushResult> => {
      const response = await doFetch(buildUrl(base, batchPath), {
        method: "POST",
        headers: { ...resolveHeaders(cfg), "Content-Type": "application/json" },
        body: JSON.stringify(batch),
        ...(request?.signal !== undefined ? { signal: request.signal } : {}),
      });
      const body = (await readJson(response)) as Record<string, unknown> | null;
      return typeof body?.syncToken === "string" ? { syncToken: body.syncToken } : {};
    };
  }

  return adapter;
}
