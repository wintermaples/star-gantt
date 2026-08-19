import type { Disposable } from "../index";
import type { DisposableLedger } from "./kernel";

// docs/specs/architecture.md §1.4
/** The core owns disposal of everything registered through `ctx.own()`. */
export class DisposableLedgerImpl implements DisposableLedger {
  private _byOwner = new Map<string, Disposable[]>();

  // docs/specs/architecture.md §1.4 — the re-mount guarantee (docs/specs/architecture.md §1.4) requires
  // every owned resource to be released even when one dispose() throws, so errors are reported
  // through this hook and the sweep continues.
  constructor(private readonly _onError?: (ownerPluginId: string, error: unknown) => void) {}

  own(ownerPluginId: string, d: Disposable): void {
    const l = this._byOwner.get(ownerPluginId);
    if (l) l.push(d);
    else this._byOwner.set(ownerPluginId, [d]);
  }

  releaseAll(ownerPluginId: string): void {
    const l = this._byOwner.get(ownerPluginId);
    if (!l) return;
    this._byOwner.delete(ownerPluginId);
    for (let i = l.length - 1; i >= 0; i--) {
      try {
        l[i]!.dispose();
      } catch (err) {
        this._onError?.(ownerPluginId, err);
      }
    }
  }
}
