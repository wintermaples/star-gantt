// docs/specs/plugins/portfolio.md §2.1, §2.4
/**
 * The portfolio node and goal registries: plugin-local, hostless state outside the
 * transaction/patch/undo pipeline (the calendars-registry precedent). Nodes form a ranked
 * hierarchy (initiative > program > project); a project node binds to one task id, the root of
 * its task subtree.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import type {
  PortfolioGoal,
  PortfolioGoalId,
  PortfolioGoalInit,
  PortfolioNode,
  PortfolioNodeId,
  PortfolioNodeInit,
  PortfolioNodeKind,
  PortfolioTreeNode,
} from "../../types";

const RANK: Record<PortfolioNodeKind, number> = { initiative: 0, program: 1, project: 2 };

function isId(v: unknown): v is PortfolioNodeId {
  return typeof v === "string" || typeof v === "number";
}

function isKind(v: unknown): v is PortfolioNodeKind {
  return v === "initiative" || v === "program" || v === "project";
}

function usableName(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

/** The node/goal store. All mutation is via `define*`/`remove*`; hand-outs are copies. */
export class PortfolioRegistry {
  private readonly _nodes = new Map<PortfolioNodeId, PortfolioNode>();
  private readonly _goals = new Map<PortfolioGoalId, PortfolioGoal>();
  // Parent -> children adjacency, kept in sync by every defineNode/removeNode mutation. Lets
  // hierarchy traversal (projectsUnder, the lift-on-redefine step) walk only the affected
  // subtree instead of rescanning the whole node map.
  private readonly _childrenOf = new Map<PortfolioNodeId, Set<PortfolioNodeId>>();
  private _idSeq = 0;
  private readonly _nameSeq: Record<PortfolioNodeKind, number> = {
    initiative: 0,
    program: 0,
    project: 0,
  };
  private _goalNameSeq = 0;

  constructor(
    private readonly _nodeName: (arg: { kind: PortfolioNodeKind; ordinal: number }) => string,
    private readonly _goalName: (ordinal: number) => string,
  ) {}

  private freshId(prefix: string): string {
    let id: string;
    do id = `${prefix}-${++this._idSeq}`;
    while (this._nodes.has(id) || this._goals.has(id));
    return id;
  }

  private _linkParent(childId: PortfolioNodeId, parentId: PortfolioNodeId | undefined): void {
    if (parentId === undefined) return;
    let set = this._childrenOf.get(parentId);
    if (set === undefined) {
      set = new Set();
      this._childrenOf.set(parentId, set);
    }
    set.add(childId);
  }

  private _unlinkParent(childId: PortfolioNodeId, parentId: PortfolioNodeId | undefined): void {
    if (parentId === undefined) return;
    const set = this._childrenOf.get(parentId);
    if (set === undefined) return;
    set.delete(childId);
    if (set.size === 0) this._childrenOf.delete(parentId);
  }

  /** Defines (or replaces, on id collision) a node. Unusable inits return `undefined`. */
  defineNode(init: PortfolioNodeInit | undefined): PortfolioNodeId | undefined {
    if (init === null || typeof init !== "object") return undefined;
    const kind = isKind(init.kind) ? init.kind : "project";
    const id = isId(init.id) ? init.id : this.freshId("node");
    let parentId: PortfolioNodeId | undefined;
    if (isId(init.parentId) && init.parentId !== id) {
      const parent = this._nodes.get(init.parentId);
      // A parent must already exist and sit strictly above the child in rank.
      if (parent !== undefined && RANK[parent.kind] < RANK[kind]) parentId = parent.id;
    }
    const name = usableName(init.name)
      ? init.name
      : this._nodeName({ kind, ordinal: ++this._nameSeq[kind] });
    const taskId = kind === "project" && isId(init.taskId) ? (init.taskId as TaskId) : undefined;
    const node: PortfolioNode = {
      id,
      name,
      kind,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
    };
    const previous = this._nodes.get(id);
    const replaced = previous !== undefined;
    if (replaced) this._unlinkParent(id, previous.parentId);
    this._nodes.set(id, node);
    this._linkParent(id, parentId);
    // Replacing a node can lower its rank (e.g. initiative -> project); children that pointed at
    // it must keep the §2.1 invariant "a parent sits strictly above its child in rank", so any
    // child the redefined node can no longer parent becomes a root. Only `id`'s own children can
    // be affected, so the parent->children index (not a full node-map scan) finds them.
    if (replaced) {
      for (const childId of [...(this._childrenOf.get(id) ?? [])]) {
        // `childId === id` (self-parenting) can never occur: `defineNode` rejects
        // `init.parentId === id` up front, so `id` is never linked into its own child set.
        const child = this._nodes.get(childId);
        if (child === undefined) continue;
        if (RANK[node.kind] < RANK[child.kind]) continue;
        const lifted: PortfolioNode = { ...child };
        delete lifted.parentId;
        this._nodes.set(childId, lifted);
        this._unlinkParent(childId, id);
      }
    }
    return id;
  }

  /** Removes a node; its children become children of its parent (or roots). */
  removeNode(id: PortfolioNodeId): boolean {
    const node = this._nodes.get(id);
    if (node === undefined) return false;
    this._nodes.delete(id);
    this._unlinkParent(id, node.parentId);
    const parentId = node.parentId;
    const grand = parentId !== undefined ? this._nodes.get(parentId) : undefined;
    // Only `id`'s own children need re-parenting; the index gives them directly instead of a
    // full node-map scan.
    for (const childId of [...(this._childrenOf.get(id) ?? [])]) {
      const child = this._nodes.get(childId);
      if (child === undefined) continue;
      const lifted: PortfolioNode = { ...child };
      delete lifted.parentId;
      this._unlinkParent(childId, id);
      if (grand !== undefined && parentId !== undefined && RANK[grand.kind] < RANK[child.kind]) {
        lifted.parentId = parentId;
        this._linkParent(childId, parentId);
      }
      this._nodes.set(childId, lifted);
    }
    this._childrenOf.delete(id);
    return true;
  }

  node(id: PortfolioNodeId): Readonly<PortfolioNode> | undefined {
    const n = this._nodes.get(id);
    return n === undefined ? undefined : { ...n };
  }

  /** Every node, in definition order. */
  list(): PortfolioNode[] {
    return [...this._nodes.values()].map((n) => ({ ...n }));
  }

  /** The hierarchy nested, roots in definition order, children in definition order. */
  tree(): PortfolioTreeNode[] {
    const byParent = new Map<PortfolioNodeId | undefined, PortfolioNode[]>();
    for (const n of this._nodes.values()) {
      const key = n.parentId !== undefined && this._nodes.has(n.parentId) ? n.parentId : undefined;
      const bucket = byParent.get(key);
      if (bucket === undefined) byParent.set(key, [n]);
      else bucket.push(n);
    }
    const build = (parent: PortfolioNodeId | undefined): PortfolioTreeNode[] =>
      (byParent.get(parent) ?? []).map((n) => ({ ...n, children: build(n.id) }));
    return build(undefined);
  }

  /**
   * The project nodes at or below a node, in definition order — the node itself when it is a
   * project, its project descendants otherwise. Empty for unknown ids.
   */
  projectsUnder(id: PortfolioNodeId): PortfolioNode[] {
    if (!this._nodes.has(id)) return [];
    // Walk the parent->children index from `id` outward: touches only the subtree below `id`,
    // not the whole node map, however many unrelated nodes the registry holds.
    const included = new Set<PortfolioNodeId>([id]);
    const stack: PortfolioNodeId[] = [id];
    while (stack.length > 0) {
      const current = stack.pop() as PortfolioNodeId;
      for (const childId of this._childrenOf.get(current) ?? []) {
        if (included.has(childId)) continue;
        included.add(childId);
        stack.push(childId);
      }
    }
    // Final pass over all nodes only to recover definition order among the included set (the
    // index has no ordering of its own); this is a single O(n) pass, not a repeated rescan.
    return [...this._nodes.values()]
      .filter((n) => included.has(n.id) && n.kind === "project")
      .map((n) => ({ ...n }));
  }

  /** Defines (or replaces, on id collision) a goal. Unusable inits return `undefined`. */
  defineGoal(init: PortfolioGoalInit | undefined): PortfolioGoalId | undefined {
    if (init === null || typeof init !== "object") return undefined;
    const id = isId(init.id) ? init.id : this.freshId("goal");
    const name = usableName(init.name) ? init.name : this._goalName(++this._goalNameSeq);
    const target =
      typeof init.target === "number" && Number.isFinite(init.target)
        ? Math.min(1, Math.max(0, init.target))
        : 1;
    const nodeIds = Array.isArray(init.nodeIds) ? init.nodeIds.filter(isId) : [];
    const taskIds = Array.isArray(init.taskIds)
      ? init.taskIds.filter((t): t is TaskId => isId(t))
      : [];
    this._goals.set(id, { id, name, nodeIds, taskIds, target });
    return id;
  }

  removeGoal(id: PortfolioGoalId): boolean {
    return this._goals.delete(id);
  }

  goal(id: PortfolioGoalId): Readonly<PortfolioGoal> | undefined {
    const g = this._goals.get(id);
    return g === undefined ? undefined : { ...g, nodeIds: [...g.nodeIds], taskIds: [...g.taskIds] };
  }

  /** Every goal, in definition order. */
  goals(): PortfolioGoal[] {
    return [...this._goals.values()].map((g) => ({
      ...g,
      nodeIds: [...g.nodeIds],
      taskIds: [...g.taskIds],
    }));
  }
}
