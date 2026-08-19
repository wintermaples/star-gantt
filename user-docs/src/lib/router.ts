import { useEffect, useState } from "react";

/** Reads the current hash route, normalised to a leading slash, no query and no trailing slash. */
export function currentRoute(): string {
  const raw = (window.location.hash.replace(/^#/, "") || "/").split("?")[0] ?? "/";
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** The query string carried after the hash route, e.g. `#/reference/x?p=barRadius`. */
export function currentQuery(): URLSearchParams {
  return new URLSearchParams(window.location.hash.split("?")[1] ?? "");
}

/** Subscribes to hash changes. A hash router keeps the site deployable as static files. */
export function useRoute(): string {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const onChange = (): void => {
      setRoute(currentRoute());
      window.scrollTo(0, 0);
      document.querySelector(".main")?.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export const href = (route: string): string => `#${route}`;
