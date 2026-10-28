export type RegionName = "banner" | "header" | "landAck" | "footer" | "main";

export const REGIONS: Record<RegionName, { selector: string; strict: boolean }> = {
  banner: { selector: "#banner", strict: true },
  header: { selector: "header#main-nav", strict: true },
  landAck: { selector: "#landAcknowledgement", strict: true },
  footer: { selector: "#footer", strict: true },
  main: { selector: "#main-content", strict: false },
};

/** Largest mismatch ratio a strict region may have. Measured noise floor 0.0000 (legacy vs legacy and ours vs ours); see docs/parity/inputs/look-and-feel.md "Plan 1 result". */
export const STRICT_MAX = 0.03;
