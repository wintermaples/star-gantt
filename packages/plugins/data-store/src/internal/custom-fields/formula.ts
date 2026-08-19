// docs/specs/plugins/data-store.md — Services (`stargantt.fields`): the formula language — an
// in-house tokenizer + recursive-descent parser (no eval/Function), parsed once at setup();
// evaluation cannot throw and every failure mode yields `undefined` for that task only.

/** A value an expression node evaluates to. Booleans exist only between comparisons and `IF`. */
export type FormulaValue = number | string | boolean;

export type FormulaNode =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "ref"; name: string }
  | { kind: "unary"; op: "-"; operand: FormulaNode }
  | { kind: "binary"; op: BinaryOp; left: FormulaNode; right: FormulaNode }
  | { kind: "call"; fn: FunctionName; args: FormulaNode[] };

export type BinaryOp = "+" | "-" | "*" | "/" | "&" | "=" | "<>" | "<" | "<=" | ">" | ">=";
export type FunctionName = "IF" | "ROUND" | "ABS" | "MIN" | "MAX" | "LEN" | "CONCAT";

const FUNCTION_NAMES: readonly FunctionName[] = ["IF", "ROUND", "ABS", "MIN", "MAX", "LEN", "CONCAT"];

/* --------------------------------- tokenizer --------------------------------- */

type Token =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "ident"; name: string }
  | { kind: "op"; op: string };

function tokenize(text: string): Token[] | undefined {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
    } else if (c >= "0" && c <= "9") {
      const m = /^\d+(\.\d+)?/.exec(text.slice(i))!;
      out.push({ kind: "num", value: Number(m[0]) });
      i += m[0].length;
    } else if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end === -1) return undefined; // unterminated string
      out.push({ kind: "str", value: text.slice(i + 1, end) });
      i = end + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))!;
      out.push({ kind: "ident", name: m[0] });
      i += m[0].length;
    } else if (c === "<" && (text[i + 1] === ">" || text[i + 1] === "=")) {
      out.push({ kind: "op", op: text.slice(i, i + 2) });
      i += 2;
    } else if (c === ">" && text[i + 1] === "=") {
      out.push({ kind: "op", op: ">=" });
      i += 2;
    } else if ("+-*/&=<>(),".includes(c)) {
      out.push({ kind: "op", op: c });
      i += 1;
    } else {
      return undefined; // unknown character
    }
  }
  return out;
}

/* ---------------------------------- parser ----------------------------------- */

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private takeOp(...ops: string[]): string | undefined {
    const t = this.peek();
    if (t !== undefined && t.kind === "op" && ops.includes(t.op)) {
      this.pos += 1;
      return t.op;
    }
    return undefined;
  }

  parse(): FormulaNode | undefined {
    const node = this.compare();
    return node !== undefined && this.pos === this.tokens.length ? node : undefined;
  }

  /** compare := concat ((= | <> | < | <= | > | >=) concat)?  — non-associative. */
  private compare(): FormulaNode | undefined {
    const left = this.concat();
    if (left === undefined) return undefined;
    const op = this.takeOp("=", "<>", "<", "<=", ">", ">=");
    if (op === undefined) return left;
    const right = this.concat();
    if (right === undefined) return undefined;
    return { kind: "binary", op: op as BinaryOp, left, right };
  }

  /** concat := additive (& additive)* */
  private concat(): FormulaNode | undefined {
    let left = this.additive();
    while (left !== undefined && this.takeOp("&") !== undefined) {
      const right = this.additive();
      if (right === undefined) return undefined;
      left = { kind: "binary", op: "&", left, right };
    }
    return left;
  }

  /** additive := multiplicative ((+ | -) multiplicative)* */
  private additive(): FormulaNode | undefined {
    let left = this.multiplicative();
    for (;;) {
      if (left === undefined) return undefined;
      const op = this.takeOp("+", "-");
      if (op === undefined) return left;
      const right = this.multiplicative();
      if (right === undefined) return undefined;
      left = { kind: "binary", op: op as BinaryOp, left, right };
    }
  }

  /** multiplicative := unary ((* | /) unary)* */
  private multiplicative(): FormulaNode | undefined {
    let left = this.unary();
    for (;;) {
      if (left === undefined) return undefined;
      const op = this.takeOp("*", "/");
      if (op === undefined) return left;
      const right = this.unary();
      if (right === undefined) return undefined;
      left = { kind: "binary", op: op as BinaryOp, left, right };
    }
  }

  /** unary := - unary | primary */
  private unary(): FormulaNode | undefined {
    if (this.takeOp("-") !== undefined) {
      const operand = this.unary();
      return operand === undefined ? undefined : { kind: "unary", op: "-", operand };
    }
    return this.primary();
  }

  /** primary := number | string | ident | fn(args) | (compare) */
  private primary(): FormulaNode | undefined {
    const t = this.peek();
    if (t === undefined) return undefined;
    if (t.kind === "num") {
      this.pos += 1;
      return { kind: "num", value: t.value };
    }
    if (t.kind === "str") {
      this.pos += 1;
      return { kind: "str", value: t.value };
    }
    if (t.kind === "ident") {
      this.pos += 1;
      if (this.takeOp("(") === undefined) return { kind: "ref", name: t.name };
      // Function call — the name must be a known function (case-insensitive).
      const fn = FUNCTION_NAMES.find((f) => f === t.name.toUpperCase());
      if (fn === undefined) return undefined;
      const args: FormulaNode[] = [];
      if (this.takeOp(")") === undefined) {
        for (;;) {
          const arg = this.compare();
          if (arg === undefined) return undefined;
          args.push(arg);
          if (this.takeOp(",") !== undefined) continue;
          if (this.takeOp(")") !== undefined) break;
          return undefined;
        }
      }
      return { kind: "call", fn, args };
    }
    if (t.kind === "op" && t.op === "(") {
      this.pos += 1;
      const inner = this.compare();
      if (inner === undefined || this.takeOp(")") === undefined) return undefined;
      return inner;
    }
    return undefined;
  }
}

/** Parses a formula text to its AST, or `undefined` when the text is not a valid expression. */
export function parseFormula(text: unknown): FormulaNode | undefined {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  const tokens = tokenize(text);
  if (tokens === undefined || tokens.length === 0) return undefined;
  return new Parser(tokens).parse();
}

/* --------------------------------- evaluator ---------------------------------- */

/** Formats a number the way the number cell shows it: up to two fraction digits, no trailing 0s. */
export function formatNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

/** The display-text coercion `&` and `CONCAT` apply; booleans have no display text. */
function toText(value: FormulaValue): string | undefined {
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return value;
  return undefined;
}

function asNumber(value: FormulaValue | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Resolves an identifier to its value; `undefined` fails the evaluation. */
export type FormulaResolver = (name: string) => FormulaValue | undefined;

/**
 * Evaluates a parsed formula. Any type mismatch, unresolved identifier, division by zero or
 * non-finite intermediate result yields `undefined` (an empty cell) — evaluation never throws.
 */
export function evaluateFormula(
  node: FormulaNode,
  resolve: FormulaResolver,
): FormulaValue | undefined {
  switch (node.kind) {
    case "num":
      return node.value;
    case "str":
      return node.value;
    case "ref":
      return resolve(node.name);
    case "unary": {
      const v = asNumber(evaluateFormula(node.operand, resolve));
      return v === undefined ? undefined : -v;
    }
    case "binary":
      return evaluateBinary(node.op, node.left, node.right, resolve);
    case "call":
      return evaluateCall(node.fn, node.args, resolve);
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

function finiteOrFail(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

/** One binary operator, applied to two already-evaluated operands. */
type BinaryImpl = (left: FormulaValue, right: FormulaValue) => FormulaValue | undefined;

/** Wraps an arithmetic rule: both operands must be numbers, or the expression fails. */
function arithmetic(compute: (a: number, b: number) => number | undefined): BinaryImpl {
  return (left, right) =>
    typeof left === "number" && typeof right === "number" ? compute(left, right) : undefined;
}

/** Ordering requires matching types (both numbers or both strings). */
function comparison(op: "<" | "<=" | ">" | ">="): BinaryImpl {
  return (left, right) => {
    if (typeof left === "number" && typeof right === "number") return order(op, left, right);
    if (typeof left === "string" && typeof right === "string") return order(op, left, right);
    return undefined;
  };
}

/** Mixed types are simply unequal (never a failure). */
function equalValues(left: FormulaValue, right: FormulaValue): boolean {
  return typeof left === typeof right && left === right;
}

// One entry per operator, so a new `BinaryOp` variant is a compile error rather than a silent
// no-op (the exhaustiveness rule the old `switch`'s `never` case enforced).
const BINARY_OPS = {
  "&": (left, right) => {
    const l = toText(left);
    const r = toText(right);
    return l === undefined || r === undefined ? undefined : l + r;
  },
  "+": arithmetic((a, b) => finiteOrFail(a + b)),
  "-": arithmetic((a, b) => finiteOrFail(a - b)),
  "*": arithmetic((a, b) => finiteOrFail(a * b)),
  "/": arithmetic((a, b) => (b === 0 ? undefined : finiteOrFail(a / b))),
  "=": (left, right) => equalValues(left, right),
  "<>": (left, right) => !equalValues(left, right),
  "<": comparison("<"),
  "<=": comparison("<="),
  ">": comparison(">"),
  ">=": comparison(">="),
} satisfies Record<BinaryOp, BinaryImpl>;

function evaluateBinary(
  op: BinaryOp,
  leftNode: FormulaNode,
  rightNode: FormulaNode,
  resolve: FormulaResolver,
): FormulaValue | undefined {
  const left = evaluateFormula(leftNode, resolve);
  if (left === undefined) return undefined;
  const right = evaluateFormula(rightNode, resolve);
  if (right === undefined) return undefined;
  return BINARY_OPS[op](left, right);
}

function order<T extends number | string>(op: "<" | "<=" | ">" | ">=", a: T, b: T): boolean {
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

/** One built-in function, applied to its unevaluated argument nodes. */
type CallImpl = (args: FormulaNode[], resolve: FormulaResolver) => FormulaValue | undefined;

function callIf(args: FormulaNode[], resolve: FormulaResolver): FormulaValue | undefined {
  if (args.length !== 3) return undefined;
  const cond = evaluateFormula(args[0]!, resolve);
  if (typeof cond !== "boolean") return undefined;
  return evaluateFormula(cond ? args[1]! : args[2]!, resolve);
}

function callRound(args: FormulaNode[], resolve: FormulaResolver): FormulaValue | undefined {
  if (args.length !== 1 && args.length !== 2) return undefined;
  const x = asNumber(evaluateFormula(args[0]!, resolve));
  if (x === undefined) return undefined;
  const digits = args.length === 2 ? asNumber(evaluateFormula(args[1]!, resolve)) : 0;
  if (digits === undefined || !Number.isInteger(digits)) return undefined;
  const factor = 10 ** digits;
  return finiteOrFail(Math.round(x * factor) / factor);
}

function callAbs(args: FormulaNode[], resolve: FormulaResolver): FormulaValue | undefined {
  if (args.length !== 1) return undefined;
  const x = asNumber(evaluateFormula(args[0]!, resolve));
  return x === undefined ? undefined : Math.abs(x);
}

/** `MIN` / `MAX`: every argument must be a number, and there must be at least one. */
function extremum(pick: (a: number, b: number) => number): CallImpl {
  return (args, resolve) => {
    if (args.length === 0) return undefined;
    let best: number | undefined;
    for (const arg of args) {
      const x = asNumber(evaluateFormula(arg, resolve));
      if (x === undefined) return undefined;
      best = best === undefined ? x : pick(best, x);
    }
    return best;
  };
}

function callLen(args: FormulaNode[], resolve: FormulaResolver): FormulaValue | undefined {
  if (args.length !== 1) return undefined;
  const s = evaluateFormula(args[0]!, resolve);
  return typeof s === "string" ? s.length : undefined;
}

function callConcat(args: FormulaNode[], resolve: FormulaResolver): FormulaValue | undefined {
  let out = "";
  for (const arg of args) {
    const v = evaluateFormula(arg, resolve);
    const text = v === undefined ? undefined : toText(v);
    if (text === undefined) return undefined;
    out += text;
  }
  return out;
}

// One entry per built-in, so adding a `FunctionName` variant without an implementation is a
// compile error (the exhaustiveness rule the old `switch`'s `never` case enforced).
const CALLS = {
  IF: callIf,
  ROUND: callRound,
  ABS: callAbs,
  MIN: extremum(Math.min),
  MAX: extremum(Math.max),
  LEN: callLen,
  CONCAT: callConcat,
} satisfies Record<FunctionName, CallImpl>;

function evaluateCall(
  fn: FunctionName,
  args: FormulaNode[],
  resolve: FormulaResolver,
): FormulaValue | undefined {
  return CALLS[fn](args, resolve);
}
