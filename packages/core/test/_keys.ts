/**
 * Shared test key space + helpers.
 *
 * This file doubles as the §5.1-required end-to-end proof that the four
 * declaration-merging surfaces (`Services` / `Events` / `Commands` / `ExtensionPoints`)
 * really are augmentable from outside the core, exactly as a plugin package would do it
 * (contract §2). Nothing here enters the runtime bundle — it is types-only.
 */
import { definePlugin } from "../src/index";
import type { AnyPlugin, ExtensionPointDecl, PluginContext, PluginMeta } from "../src/index";

export interface AlphaService {
  readonly name: string;
  ping(): string;
}

export interface BetaService {
  value: number;
}

export type NumToString = (x: number) => string | undefined;

declare module "../src/index" {
  interface Services {
    "test.alpha": AlphaService;
    "test.beta": BetaService;
    "test.gamma": BetaService;
  }

  interface Events {
    "test/plain": { v: string };
    "test/ping": { n: number };
    "test/loop": void;
    "test/boom": void;
  }

  interface Commands {
    "test/inc": { by: number };
    "test/noop": void;
    "test/boom": void;
    "test/unregistered": void;
  }

  interface ExtensionPoints {
    "test/collect": ExtensionPointDecl<string, string[]>;
    "test/first": ExtensionPointDecl<NumToString, NumToString>;
    "test/reduce": ExtensionPointDecl<number, number>;
    "test/buffered": ExtensionPointDecl<string, string[]>;
    "test/fnvalues": ExtensionPointDecl<NumToString, NumToString[]>;
    "test/badReducer": ExtensionPointDecl<string, string[]>;
  }
}

/**
 * The core references `HTMLElement` as a *type* only (contract §1.1 / §1.7), so a plain
 * object is a sufficient stand-in under vitest's default node environment.
 */
export const fakeRoot = (): HTMLElement => ({}) as unknown as HTMLElement;

/** Convenience `definePlugin` wrapper for tests. */
export function plug(
  id: string,
  setup: (ctx: PluginContext) => void | (() => void),
  meta: Omit<PluginMeta, "id"> = {},
): AnyPlugin {
  return definePlugin({ meta: { id, ...meta }, setup });
}
