// docs/specs/plugins/view.md — internal module, not part of the published surface.
/**
 * The setup-time theme warnings (docs/specs/plugins/view.md).
 *
 * Both catch a host mistake that is otherwise invisible, because in both cases the CSS is valid and
 * simply does not do what its author meant:
 *
 * - a **retired** token the host still declares, which the library no longer reads;
 * - a **partial palette** on a chart whose scheme is not pinned, where the tokens the host did not
 * override keep following the OS. That is the mixed rendering — a dark palette with white zebra
 * rows on a light OS — that the per-chart scheme classes (§4.2) exist to make unreachable.
 *
 * The comparison is pure (`diagnose`), and the DOM work needed to feed it — two probe elements
 * that report what the library's own defaults resolve to in each scheme — is a separate function
 * so the rule can be tested without a browser. The defaults are *measured*, never mirrored into
 * TS: forbids that, and reading them off the page also folds in whatever the host declared
 * on `:root`, which is exactly what "the library's default here" should mean.
 */
import { SCHEME_CLASSES } from "./scheme";

/** Everything `diagnose` compares. All readers return a computed value, or `""` when unset. */
export interface DiagnosticsInput {
  /** The token names to consider — the canvas-read set. */
  readonly tokens: readonly string[];
  /** The chart root's own resolved value for a token. */
  readonly readRoot: (token: string) => string;
  /** What the token resolves to under the library's defaults in the light scheme. */
  readonly readLight: (token: string) => string;
  /** What the token resolves to under the library's defaults in the dark scheme. */
  readonly readDark: (token: string) => string;
  /** `true` when the chart's scheme is pinned, which makes the partial-palette check moot. */
  readonly schemePinned: boolean;
  /** Retired token name → the advice that replaces it. */
  readonly retired: Readonly<Record<string, string>>;
}

/** The warnings this palette earns, in the order they should be reported. Empty means healthy. */
export function diagnose(input: DiagnosticsInput): string[] {
  const out: string[] = [];

  for (const [name, advice] of Object.entries(input.retired)) {
    // The library does not declare these, so a non-empty computed value can only be the host's.
    if (input.readRoot(name).trim() !== "") {
      out.push(`the retired token ${name} is declared but no longer read — ${advice}.`);
    }
  }

  if (input.schemePinned) return out;

  // Only scheme-dependent tokens can end up on the wrong side of a `light-dark()` pair; a
  // scheme-shared token (a font, a length, a colour that is deliberately identical in both
  // schemes) carries no risk and would only inflate the count.
  let overridden = 0;
  let stillDefault = 0;
  for (const token of input.tokens) {
    const light = input.readLight(token);
    const dark = input.readDark(token);
    if (light === "" || light === dark) continue;
    const actual = input.readRoot(token);
    if (actual === light || actual === dark) stillDefault += 1;
    else overridden += 1;
  }
  if (overridden > 0 && stillDefault > 0) {
    out.push(
      `this chart overrides ${String(overridden)} theme token(s) but does not pin a colour scheme, ` +
        `so the ${String(stillDefault)} scheme-dependent token(s) it leaves alone still follow the ` +
        `OS and can paint the other scheme's values. Add the class "sg-scheme-light" or ` +
        `"sg-scheme-dark" to the chart element, or set ThemeConfig.colorScheme.`,
    );
  }
  return out;
}

/** The document members the probes need; absent in the unit tests' fake DOM. */
interface ProbeHostLike {
  ownerDocument?: { createElement?(tag: string): unknown } | null;
  appendChild?(child: unknown): unknown;
  removeChild?(child: unknown): unknown;
}

/** A reader per scheme, or `null` when the environment cannot host a probe element. */
export interface SchemeProbes {
  readLight: (token: string) => string;
  readDark: (token: string) => string;
}

/**
 * Measures the library's default palette in both schemes by briefly mounting one probe element per
 * scheme class inside the chart root, reading every token off it, and removing it again — all
 * synchronously, so nothing else can observe the children.
 *
 * The probes must be children of the chart root rather than of `<body>`: the root is where the
 * host's own theme classes and any inherited overrides are in scope, and "the default here" has to
 * mean "here".
 */
export function measureSchemeDefaults(
  root: ProbeHostLike,
  tokens: readonly string[],
): SchemeProbes | null {
  const doc = root.ownerDocument;
  if (
    doc === null ||
    doc === undefined ||
    typeof doc.createElement !== "function" ||
    typeof root.appendChild !== "function" ||
    typeof root.removeChild !== "function" ||
    typeof globalThis.getComputedStyle !== "function"
  ) {
    return null;
  }

  const read: Record<string, Map<string, string>> = {};
  for (const className of SCHEME_CLASSES) {
    const probe = doc.createElement("div") as {
      className: string;
      style: { display: string };
    };
    probe.className = className;
    // The probe must not affect layout for the frame it exists in; `display: none` still resolves
    // inherited custom properties, which is all it is read for.
    probe.style.display = "none";
    root.appendChild(probe);
    const computed = globalThis.getComputedStyle(probe as unknown as Element);
    const values = new Map<string, string>();
    for (const token of tokens) values.set(token, computed.getPropertyValue(token).trim());
    root.removeChild(probe);
    read[className] = values;
  }

  const light = read["sg-scheme-light"];
  const dark = read["sg-scheme-dark"];
  if (light === undefined || dark === undefined) return null;
  return {
    readLight: (token) => light.get(token) ?? "",
    readDark: (token) => dark.get(token) ?? "",
  };
}
