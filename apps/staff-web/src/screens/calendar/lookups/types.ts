export interface LookupExtra {
  key: string;
  label: string;
  max: number;
}
export interface LookupSummary {
  name: string;
  label: string;
  singular: string;
  editable: boolean;
  minRole: string;
  nameMax: number;
  extras: LookupExtra[];
}
export interface LookupRowView {
  id: number;
  name: string;
  sortOrder: number;
  isActive: boolean;
  extras: Record<string, string | null>;
}
export interface LookupDetail extends LookupSummary {
  rows: LookupRowView[];
}

/** "an HQ tag", "a city". */
export function withArticle(singular: string): string {
  return `${/^[aeiouAEIOU]|^HQ\b|^NR\b/.test(singular) ? "an" : "a"} ${singular}`;
}
