/**
 * The legacy PostDto lists a post's translations and media assets as `{ key, label, length }`
 * with a RELATIVE `key` ("releases/2026HLTH0085-001117/Flyer_Chinese(simplified).pdf"); news.gov
 * links them on its Azure Front Door files host. Our News API contract wants an ABSOLUTE URL
 * there (`AssetDto.key`), so the importer makes one.
 */

export const DEFAULT_FILES_BASE = "https://bcgovnews-etg7c8etapa6btfr.z03.azurefd.net";

export type FileKind = "translations" | "assets";

/** Encodes one path segment, including the characters encodeURIComponent leaves bare. */
const encodeSegment = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Makes `key` an absolute file URL under `${filesBase}/${kind}/`; absolute https keys pass through, anything else throws. */
export function absoluteFileKey(key: string, kind: FileKind, filesBase: string): string {
  if (/^https:\/\//i.test(key)) return key;
  if (/^[a-z][a-z0-9+.-]*:/i.test(key) || key.startsWith("//")) throw new Error(`unsupported ${kind} key "${key}" (not a relative path or an https URL)`);
  const segments = key.replace(/^\/+/, "").split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw new Error(`unsupported ${kind} key "${key}" (empty or dot path segment)`);
  return `${filesBase.replace(/\/+$/, "")}/${kind}/${segments.map(encodeSegment).join("/")}`;
}

type Item = { key: string | null; label: string | null; length: number | null };

/** The list with every key made absolute (null stays null; an item with a null key is kept as is). */
export function absoluteFileItems(items: unknown, kind: FileKind, filesBase: string): Item[] | null {
  if (!Array.isArray(items)) return null;
  return items.map((it: Item) => (it && typeof it.key === "string" ? { ...it, key: absoluteFileKey(it.key, kind, filesBase) } : it));
}
