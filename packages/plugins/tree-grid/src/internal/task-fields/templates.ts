// docs/specs/plugins/tree-grid.md § Internal modules — "Templates".
import { MS_DAY } from "@stargantt/sdk";
import type { TaskTemplate } from "../../types";
import { fieldsOfTask, META_KEY } from "./fields";
import type { Task } from "@stargantt/plugin-data-store";

/** A template with its unusable members already dropped. */
export interface ResolvedTemplate {
  fields: Readonly<TaskTemplate["fields"] & object>;
  name: string | undefined;
  durationMs: number | undefined;
}

/**
 * Narrows a raw `templates` config value: entries that are not plain objects are dropped, and
 * inside each entry the fields bag is passed through the same defensive reader the store reads
 * use, so a template can never write an unusable value.
 */
export function resolveTemplates(raw: unknown): Map<string, ResolvedTemplate> {
  const out = new Map<string, ResolvedTemplate>();
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const fields = fieldsOfTask({ meta: { [META_KEY]: e["fields"] } } as unknown as Task);
    const name2 = typeof e["name"] === "string" && e["name"] !== "" ? e["name"] : undefined;
    const durationMs =
      typeof e["durationMs"] === "number" && Number.isFinite(e["durationMs"]) && e["durationMs"] > 0
        ? e["durationMs"]
        : undefined;
    out.set(name, { fields, name: name2, durationMs });
  }
  return out;
}

/** The start of the current UTC day — the default start of a task created from a template. */
export function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export { MS_DAY };
