import { useState } from "react";
import type { ThemeChoice } from "../lib/theme";
import { THEME_LABEL, applyTheme, nextTheme, storedTheme } from "../lib/theme";

/**
 * One button per state, drawn as an icon: a monitor while the OS decides, a sun for light, a moon
 * for dark. The state is also in the accessible name and the tooltip, so the meaning never rests on
 * the glyph — or on the colour it happens to be drawn in.
 */
const ICON: Readonly<Record<ThemeChoice, React.JSX.Element>> = {
  system: (
    <>
      <rect x="2.5" y="3.5" width="13" height="9" rx="1.5" />
      <path d="M6 15.5h6" />
    </>
  ),
  light: (
    <>
      <circle cx="9" cy="9" r="3.5" />
      <path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M14.3 3.7l-1.4 1.4M5.1 12.9l-1.4 1.4" />
    </>
  ),
  dark: <path d="M14.5 11.3A6 6 0 0 1 6.7 3.5a6 6 0 1 0 7.8 7.8Z" />,
};

export function ThemeToggle(): React.JSX.Element {
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme);
  const following = nextTheme(choice);

  return (
    <button
      type="button"
      className="theme-btn"
      title={`Theme: ${THEME_LABEL[choice]}`}
      aria-label={`Theme: ${THEME_LABEL[choice]}. Switch to ${THEME_LABEL[following]}.`}
      onClick={() => {
        applyTheme(following);
        setChoice(following);
      }}
    >
      <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        {ICON[choice]}
      </svg>
    </button>
  );
}
