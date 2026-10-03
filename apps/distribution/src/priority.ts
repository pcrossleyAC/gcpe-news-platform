const BASE = { system: 100, media: 40, immediate: 30, digest: 20 } as const;
export type PriorityKind = keyof typeof BASE;

export function priorityFor(kind: PriorityKind, email: string, internalDomains: string[]): number {
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
  return BASE[kind] + (internalDomains.some((d) => d.toLowerCase() === domain) ? 2 : 0);
}
