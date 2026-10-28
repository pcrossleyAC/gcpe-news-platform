export interface ParityPage {
  name: string;
  path: string;
  /** Path on our site when it differs from the legacy path. */
  oursPath?: string;
}

export const PARITY_PAGES: ParityPage[] = [
  { name: "home", path: "/" },
  { name: "ministry", path: "/ministries/health" },
  { name: "sector", path: "/sectors/economy" },
  { name: "release", path: "/releases/2026HLTH0085-001117" },
  { name: "search", path: "/search?q=housing" },
  { name: "subscribe", path: "/subscribe" },
  { name: "connect", path: "/connect" },
  { name: "contacts", path: "/contacts" },
];

export const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
];
