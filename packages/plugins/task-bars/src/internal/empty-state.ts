/**
 * The zero-row empty state of `stargantt.task-bars`: the single `.sg-empty` node whose presence
 * tracks "the composed row count is 0" exactly.
 */

/** What the empty state needs: a document to create the node from, and where to mount it. */
export interface EmptyStateDeps {
  /** Document the node is created from — `ctx.root.ownerDocument`. */
  document: Document;
  // The node is mounted in the element the view plugin hands out, never found by its class string:
  // `.sg-pane--chart` stays on the pane for CSS but is a view-internal detail.
  /** Chart body the node is mounted in — `ViewService.chartPaneElement()`. */
  parent: HTMLElement;
  /** The composed row count — `RowsService.rowCount()`. */
  rowCount(): number;
  /** The resolved `empty` message, fixed for the life of the instance. */
  text: string;
}

/** The empty state of one plugin instance. */
export interface EmptyState {
  /** Mounts or removes the node so its presence matches a row count of 0. */
  sync(): void;
  /** Removes the node, if any — the disposal the plugin registers through `ctx.own()`. */
  dispose(): void;
}

// No paint pass is involved, since there is nothing to paint when the count is 0, and no
// configuration switch disables the node.
/** Builds the empty state. It mounts nothing until `sync()` is called. */
export function createEmptyState(deps: EmptyStateDeps): EmptyState {
  let node: HTMLElement | null = null;
  return {
    sync(): void {
      if (deps.rowCount() === 0) {
        if (node !== null) return;
        const created = deps.document.createElement("div");
        created.className = "sg-empty";
        created.textContent = deps.text;
        deps.parent.appendChild(created);
        node = created;
      } else if (node !== null) {
        node.remove();
        node = null;
      }
    },
    dispose(): void {
      node?.remove();
      node = null;
    },
  };
}
