import { useEffect, useState } from "react";

/**
 * Tracks a CSS media query from React.
 *
 * Used only for layout decisions that CSS cannot express on its own — moving a whole subtree from
 * the pinned column into the reading column, for instance. Anything expressible in CSS stays in
 * the stylesheet.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (): void => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
