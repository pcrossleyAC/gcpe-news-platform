import { useEffect, useState } from "react";

/**
 * The Hub's environment banner (C331): on a test deployment, a thin strip at the top of every page
 * names it (DEV, TEST, …) in its own colour, and the browser tab's title starts with it, so nobody
 * mistakes it for production. `GET /core/environment` answers the name, or null on real production
 * (@gcpe/config environmentName), before sign-in too. Fetched once per page load.
 */
let name: string | null = null;
let request: Promise<string | null> | null = null;

function load(): Promise<string | null> {
  request ??= fetch("/core/environment", { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<{ name?: unknown }>) : { name: null }))
    .then((body) => {
      name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
      // A title set before the name arrived gets it now.
      if (name && typeof document !== "undefined") document.title = withEnvironment(document.title);
      return name;
    })
    .catch(() => null);
  return request;
}

/** `title` with the environment's name in front ("[TEST] Drafts — GCPE News Staff"), once. */
export function withEnvironment(title: string): string {
  if (!name) return title;
  const prefix = `[${name}] `;
  return title.startsWith(prefix) ? title : prefix + title;
}

/** The environment's name, null on real production (or until it has loaded). */
export function useEnvironmentName(): string | null {
  const [current, setCurrent] = useState(name);
  useEffect(() => {
    let active = true;
    void load().then((n) => active && setCurrent(n));
    return () => {
      active = false;
    };
  }, []);
  return current;
}

/** Its colour: DEV purple, TEST dark orange, any other name dark teal (each readable with white text). */
const tone = (n: string) => (n === "DEV" ? "dev" : n === "TEST" ? "test" : "other");

export function EnvironmentBanner(): React.JSX.Element | null {
  const current = useEnvironmentName();
  if (!current) return null;
  return (
    <p className={`gcpe-env-banner gcpe-env-banner--${tone(current)}`}>
      <strong>{current} site</strong>: changes here don&rsquo;t reach the live news site.
    </p>
  );
}

/** For tests: forget the loaded name. */
export function resetEnvironmentForTests(): void {
  name = null;
  request = null;
}
