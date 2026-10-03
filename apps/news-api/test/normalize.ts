const ISO_OFFSET = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?([+-]\d\d:\d\d|Z)$/;

const isLink = (o: Record<string, unknown>) => Object.keys(o).length === 3 && "uri" in o && "key" in o && "timestamp" in o;

export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === "newsletterLinks") continue;
      if (k === "timestamp" && isLink(o)) continue;
      out[k] = normalize(v);
    }
    return out;
  }
  if (typeof value === "string" && ISO_OFFSET.test(value)) return Date.parse(value.replace(/(\.\d{3})\d+/, "$1"));
  return value;
}
