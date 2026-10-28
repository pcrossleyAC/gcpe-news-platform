export type RegionName = "banner" | "header" | "landAck" | "footer" | "main";

export const REGIONS: Record<RegionName, { selector: string; strict: boolean }> = {
  banner: { selector: "#banner", strict: true },
  header: { selector: "header#main-nav", strict: true },
  landAck: { selector: "#landAcknowledgement", strict: true },
  footer: { selector: "#footer", strict: true },
  main: { selector: "#main-content", strict: false },
};

/** Largest mismatch ratio a strict region may have. Task 11 records the measured noise floor. */
export const STRICT_MAX = 0.03;
