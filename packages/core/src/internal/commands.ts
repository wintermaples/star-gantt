import type { CommandRunner, Commands } from "../index";
import type { EventBusImpl } from "./events";
import type { CommandBus } from "./kernel";

interface Entry {
  owner: string;
  run: (payload: unknown) => void;
}

export class CommandBusImpl implements CommandBus {
  private _commands = new Map<string, Entry>();

  constructor(private _bus: EventBusImpl) {}

  register<K extends keyof Commands>(ownerPluginId: string, key: K, run: CommandRunner<K>): void {
    this._commands.set(key as unknown as string, {
      owner: ownerPluginId,
      run: run as (payload: unknown) => void,
    });
  }

  // docs/specs/architecture.md §1.4
  /** Drops every registered command; a later dispatch behaves as an unknown command. */
  clear(): void {
    this._commands.clear();
  }

  dispatch<K extends keyof Commands>(key: K, payload: Commands[K]): void {
    const e = this._commands.get(key as unknown as string);
    if (!e) return;
    try {
      e.run(payload);
    } catch (err) {
      // docs/specs/architecture.md §1.4 — fault barrier around command-runner invocation.
      this._bus.fault(e.owner, err);
    }
  }
}
