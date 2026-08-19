/**
 * §2.7 the REST, local, and GraphQL adapters, plus the `graphql` config-nest gate.
 */
import { describe, expect, it } from "vitest";
import { graphqlAdapter, localAdapter, restAdapter } from "../src/index";
import { boot, task } from "./_helpers";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A scriptable `fetch` replacement that records every call and replies with `next`. */
function scriptedFetch(next: () => Response): { fn: (url: string, init?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fn: (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(next());
    },
  };
}

describe("restAdapter (§2.7)", () => {
  it("fetch: GET {load} with q/filter query params; accepts a bare array or an object body", async () => {
    const f = scriptedFetch(() => jsonResponse([task("t1", 0, 1)]));
    const adapter = restAdapter({ baseUrl: "https://api.example.com", fetch: f.fn });
    const result = await adapter.fetch({ filter: { query: "hello", criteria: { a: 1 } } });
    expect(result.tasks).toHaveLength(1);
    const url = new URL(f.calls[0]!.url);
    expect(url.pathname).toBe("/tasks");
    expect(url.searchParams.get("q")).toBe("hello");
    expect(JSON.parse(url.searchParams.get("filter")!)).toEqual({ a: 1 });
  });

  it("fetchDelta: GET {delta}?since=...; a reply without a token keeps the request's", async () => {
    const f = scriptedFetch(() => jsonResponse({ changes: [] }));
    const adapter = restAdapter({ baseUrl: "https://api.example.com", fetch: f.fn });
    const result = await adapter.fetchDelta!({ syncToken: "tok-1" });
    expect(result).toEqual({ changes: [], syncToken: "tok-1" });
    expect(new URL(f.calls[0]!.url).searchParams.get("since")).toBe("tok-1");
  });

  it("push: POST {batch} with JSON body and Content-Type header", async () => {
    const f = scriptedFetch(() => jsonResponse({ syncToken: "tok-2" }));
    const adapter = restAdapter({ baseUrl: "https://api.example.com", fetch: f.fn });
    const result = await adapter.push!({ creates: [], updates: [], removes: [] });
    expect(result).toEqual({ syncToken: "tok-2" });
    const init = f.calls[0]!.init!;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("setting delta/batch to null removes that capability", () => {
    const adapter = restAdapter({ endpoints: { delta: null, batch: null } });
    expect(adapter.fetchDelta).toBeUndefined();
    expect(adapter.push).toBeUndefined();
  });

  it("a non-2xx status rejects with an Error carrying the status code", async () => {
    const f = scriptedFetch(() => jsonResponse({}, 500));
    const adapter = restAdapter({ fetch: f.fn });
    await expect(adapter.fetch({})).rejects.toThrow(/500/);
  });

  it("forwards the request's signal onto the fetch RequestInit", async () => {
    const f = scriptedFetch(() => jsonResponse([]));
    const adapter = restAdapter({ fetch: f.fn });
    const controller = new AbortController();
    await adapter.fetch({ signal: controller.signal });
    expect(f.calls[0]!.init!.signal).toBe(controller.signal);
  });

  it("headers() as a function is called per request (short-lived auth tokens)", async () => {
    let token = "t1";
    const f = scriptedFetch(() => jsonResponse([]));
    const adapter = restAdapter({ fetch: f.fn, headers: () => ({ Authorization: `Bearer ${token}` }) });
    await adapter.fetch({});
    token = "t2";
    await adapter.fetch({});
    const first = f.calls[0]!.init!.headers as Record<string, string>;
    const second = f.calls[1]!.init!.headers as Record<string, string>;
    expect(first.Authorization).toBe("Bearer t1");
    expect(second.Authorization).toBe("Bearer t2");
  });
});

describe("localAdapter (§2.7)", () => {
  it("serves the document's current lists, read at fetch time", async () => {
    const doc = { tasks: [task("t1", 0, 1)] };
    const adapter = localAdapter(doc);
    expect((await adapter.fetch({})).tasks).toHaveLength(1);
    doc.tasks.push(task("t2", 1, 1));
    expect((await adapter.fetch({})).tasks).toHaveLength(2); // read at fetch time
    expect(adapter.fetchDelta).toBeUndefined();
    expect(adapter.push).toBeUndefined();
  });
});

describe("graphqlAdapter (§2.7)", () => {
  it("POSTs { query, variables } and selects a single-root-field data object by default", async () => {
    const f = scriptedFetch(() => jsonResponse({ data: { tasks: [task("t1", 0, 1)] } }));
    const adapter = graphqlAdapter({ url: "https://api.example.com/graphql", operations: { load: "query { tasks }" }, fetch: f.fn });
    const result = await adapter.fetch({ filter: { query: "q" } });
    expect(result.tasks).toHaveLength(1);
    const body = JSON.parse(f.calls[0]!.init!.body as string) as { query: string; variables: unknown };
    expect(body.query).toBe("query { tasks }");
    expect(body.variables).toEqual({ query: "q", criteria: null });
  });

  it("select dot-path picks a nested field; a null anywhere on the path rejects", async () => {
    const f1 = scriptedFetch(() => jsonResponse({ data: { project: { board: { tasks: [] } } } }));
    const adapter = graphqlAdapter({
      url: "https://api.example.com/graphql",
      operations: { load: "q" },
      select: { load: "project.board" },
      fetch: f1.fn,
    });
    expect((await adapter.fetch({})).tasks).toEqual([]);

    const f2 = scriptedFetch(() => jsonResponse({ data: { project: null } }));
    const nullAdapter = graphqlAdapter({
      url: "https://api.example.com/graphql",
      operations: { load: "q" },
      select: { load: "project.board" },
      fetch: f2.fn,
    });
    await expect(nullAdapter.fetch({})).rejects.toThrow(/null/);
  });

  it("a non-empty errors array rejects with the first error's message", async () => {
    const f = scriptedFetch(() => jsonResponse({ errors: [{ message: "boom" }] }));
    const adapter = graphqlAdapter({ url: "https://api.example.com/graphql", operations: { load: "q" }, fetch: f.fn });
    await expect(adapter.fetch({})).rejects.toThrow(/boom/);
  });

  it("delta/push capabilities exist only when their documents are configured", () => {
    const noOps = graphqlAdapter({ url: "https://api.example.com/graphql", operations: { load: "q" } });
    expect(noOps.fetchDelta).toBeUndefined();
    expect(noOps.push).toBeUndefined();
    const withOps = graphqlAdapter({
      url: "https://api.example.com/graphql",
      operations: { load: "q", delta: "d", push: "p" },
    });
    expect(withOps.fetchDelta).toBeDefined();
    expect(withOps.push).toBeDefined();
  });

  it("without a usable url/load document, fetch rejects with a configuration Error", async () => {
    const adapter = graphqlAdapter();
    await expect(adapter.fetch({})).rejects.toThrow(/not configured/);
  });
});

describe("graphql config-nest gate (§2.7 recorded resolution)", () => {
  it("builds and registers a graphqlAdapter under `name` when url + operations.load are usable", () => {
    const { ds } = boot({ graphql: { url: "https://api.example.com/graphql", operations: { load: "q" } } });
    expect(ds.sources.names()).toEqual(["graphql"]);
    expect(ds.sources.active()).toBeUndefined(); // activate defaults false
  });

  it("activate: true activates the registered graphql source", () => {
    const { ds } = boot({ graphql: { url: "https://api.example.com/graphql", operations: { load: "q" }, activate: true } });
    expect(ds.sources.active()).toBe("graphql");
  });

  it("a custom name is honored", () => {
    const { ds } = boot({ graphql: { url: "https://api.example.com/graphql", operations: { load: "q" }, name: "gql" } });
    expect(ds.sources.names()).toEqual(["gql"]);
  });

  it("is a complete no-op without a usable url or load document", () => {
    const { ds } = boot({ graphql: { operations: { load: "q" } } }); // no url
    expect(ds.sources.names()).toEqual([]);
    const { ds: ds2 } = boot({ graphql: { url: "https://api.example.com/graphql" } }); // no load doc
    expect(ds2.sources.names()).toEqual([]);
  });
});
