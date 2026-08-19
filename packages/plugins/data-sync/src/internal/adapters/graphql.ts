// docs/specs/plugins/data-sync.md §2.7
/**
 * The GraphQL adapter: maps the `DataSourceAdapter` interface onto host-supplied GraphQL
 * documents sent as conventional GraphQL-over-HTTP POST requests. Hostless — the fetch
 * implementation is injectable. There are no default documents: each capability exists only when
 * its document is a non-empty string.
 */
import type {
  ChangeBatch,
  DataSourceAdapter,
  DataSourceFilter,
  DeltaRequest,
  DeltaResult,
  FetchRequest,
  FetchResult,
  GraphqlAdapterConfig,
  PushResult,
} from "../../types";

function usableDocument(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function resolveHeaders(config: GraphqlAdapterConfig): Record<string, string> {
  const h = config.headers;
  if (typeof h === "function") {
    const built = h();
    return built !== null && typeof built === "object" ? built : {};
  }
  return h !== null && typeof h === "object" ? { ...h } : {};
}

/** The filter's two members as GraphQL variables, each `null` when unset. */
function filterVariables(filter: DataSourceFilter | undefined): { query: unknown; criteria: unknown } {
  return {
    query: typeof filter?.query === "string" ? filter.query : null,
    criteria: filter?.criteria ?? null,
  };
}

/**
 * Thrown when a configured `select` dot-path resolves to `null` — mid-path or as the terminal
 * value — which signals the backend explicitly has nothing there, a hard failure distinct from an
 * ordinary missing key (which yields `undefined`, tolerated as "no such data").
 */
export class GraphqlNullPathError extends Error {
  constructor(path: string) {
    super(`stargantt: data-sync graphql: select path "${path}" traverses through a null value`);
    this.name = "GraphqlNullPathError";
  }
}

/** Walks a dot-path into a value; a missing segment yields `undefined`. */
export function selectPath(data: unknown, path: string): unknown {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (current === null) throw new GraphqlNullPathError(path);
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * The §2.7 result-selection rule: an explicit dot-path when configured, otherwise a `data` object
 * with exactly one root field unwraps to that field's value, otherwise `data` itself.
 */
export function selectResult(data: unknown, path: string | undefined): unknown {
  if (usableDocument(path)) {
    const selected = selectPath(data, path);
    if (selected === null) throw new GraphqlNullPathError(path);
    return selected;
  }
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const keys = Object.keys(data as Record<string, unknown>);
    if (keys.length === 1) return (data as Record<string, unknown>)[keys[0]!];
  }
  return data;
}

/** Normalizes a load result exactly like the REST adapter's load reply. */
function normalizeFetchResult(body: unknown): FetchResult {
  if (Array.isArray(body)) return { tasks: body };
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const result: FetchResult = { tasks: Array.isArray(record.tasks) ? record.tasks : [] };
    if (Array.isArray(record.links)) result.links = record.links;
    if (Array.isArray(record.resources)) result.resources = record.resources;
    if (Array.isArray(record.assignments)) result.assignments = record.assignments;
    if (typeof record.syncToken === "string") result.syncToken = record.syncToken;
    return result;
  }
  return { tasks: [] };
}

/**
 * Creates a `DataSourceAdapter` over a GraphQL endpoint (§2.7). Every operation is one
 * `POST {url}` with a JSON `{ query, variables }` body. `load` receives `{ query, criteria }`
 * variables, `delta` additionally receives `since`, `push` receives `{ batch }`. A non-2xx
 * status, a non-empty `errors` array, or a `null`/missing `data` all reject with an `Error` — a
 * GraphQL reply is never partially applied. The delta and push capabilities exist only when their
 * documents are configured; an adapter without a usable `url` or load document still satisfies the
 * shape but its `fetch` rejects with a configuration `Error`. Every request's `signal` (when given)
 * rides on the `fetch` `RequestInit` (§1 abort machinery).
 */
export function graphqlAdapter(config?: GraphqlAdapterConfig): DataSourceAdapter {
  const cfg = config !== null && typeof config === "object" ? config : {};
  const ops = cfg.operations !== null && typeof cfg.operations === "object" ? cfg.operations : {};
  const sel = cfg.select !== null && typeof cfg.select === "object" ? cfg.select : {};
  const url = typeof cfg.url === "string" && cfg.url.trim() !== "" ? cfg.url : undefined;
  const doFetch: (input: string, init?: RequestInit) => Promise<Response> =
    typeof cfg.fetch === "function" ? cfg.fetch : (...args) => globalThis.fetch(...args);

  async function execute(
    endpoint: string,
    document: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: { ...resolveHeaders(cfg), "Content-Type": "application/json" },
      body: JSON.stringify({ query: document, variables }),
      ...(signal !== undefined ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`stargantt: data-sync graphql HTTP ${response.status}`);
    const body = (await response.json()) as { data?: unknown; errors?: unknown } | null;
    const errors = body?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const first = errors[0] as { message?: unknown } | null;
      const message = typeof first?.message === "string" ? first.message : "GraphQL error";
      throw new Error(`stargantt: data-sync graphql: ${message}`, { cause: errors });
    }
    if (body === null || body === undefined || body.data === null || body.data === undefined) {
      throw new Error("stargantt: data-sync graphql: response has no data");
    }
    return body.data;
  }

  const adapter: DataSourceAdapter = {
    async fetch(request: FetchRequest): Promise<FetchResult> {
      if (url === undefined || !usableDocument(ops.load)) {
        throw new Error("stargantt: data-sync graphql adapter is not configured (url and operations.load are required)");
      }
      const data = await execute(url, ops.load, filterVariables(request?.filter), request?.signal);
      return normalizeFetchResult(selectResult(data, sel.load));
    },
  };

  if (url !== undefined && usableDocument(ops.delta)) {
    const document = ops.delta;
    adapter.fetchDelta = async (request: DeltaRequest): Promise<DeltaResult> => {
      const data = await execute(
        url,
        document,
        { since: request.syncToken, ...filterVariables(request?.filter) },
        request?.signal,
      );
      const result = selectResult(data, sel.delta) as Partial<DeltaResult> | null | undefined;
      return {
        changes: Array.isArray(result?.changes) ? result.changes : [],
        syncToken: typeof result?.syncToken === "string" ? result.syncToken : request.syncToken,
      };
    };
  }

  if (url !== undefined && usableDocument(ops.push)) {
    const document = ops.push;
    adapter.push = async (batch: ChangeBatch, request?: { signal?: AbortSignal }): Promise<PushResult> => {
      const data = await execute(url, document, { batch }, request?.signal);
      const result = selectResult(data, sel.push) as Record<string, unknown> | null | undefined;
      return typeof result?.syncToken === "string" ? { syncToken: result.syncToken } : {};
    };
  }

  return adapter;
}
