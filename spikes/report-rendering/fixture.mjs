// 1,106 fictional activities, the live window's size (spec addendum §13, SV 4.2), 37 of them
// confidential. Deterministic, so every host renders the same bytes of input.
const MINISTRIES = ["HLTH", "FIN", "EDUC", "TRAN", "ENV", "AGRI", "JOBS", "HOUS"];
const CITIES = ["Sampletown", "Exampleville", "Testford", "Demo Bay", "Placeholder Hills"];
const SECTIONS = ["events_and_speeches", "in_the_news", "issues_and_reports", "not_on_la"];

export function makeFixture({ count = 1106, seed = 20261008, from = "2026-11-02" } = {}) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const base = Date.parse(`${from}T08:00:00-07:00`);
  return Array.from({ length: count }, (_, i) => {
    const dayOffset = Math.floor(rnd() * 150) - 30; // started up to 30 days ago, up to 120 ahead
    const spanDays = rnd() < 0.15 ? 1 + Math.floor(rnd() * 6) : 0;
    const start = new Date(base + dayOffset * 86_400_000 + Math.floor(rnd() * 20) * 1_800_000);
    const end = new Date(start.getTime() + (spanDays ? spanDays * 86_400_000 : 3_600_000));
    return {
      id: 50_000 + i,
      ministry: MINISTRIES[i % MINISTRIES.length],
      title: `Sample activity ${i + 1}`,
      details: Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => "Fictional details for the rendering spike.").join(" "),
      city: CITIES[i % CITIES.length],
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      isAllDay: spanDays > 0,
      isConfidential: i % 30 === 0,
      isIssue: rnd() < 0.1,
      hqSection: SECTIONS[Math.floor(rnd() * SECTIONS.length)],
      laStatus: rnd() < 0.1 ? "NEW" : rnd() < 0.1 ? "CHANGED" : null,
      rls: rnd() < 0.3 ? ["BCGov", "NR"] : ["-"],
      significance: "Fictional significance.",
      schedule: "Fictional scheduling note.",
      premierRequested: rnd() < 0.05 ? "Confirmed" : null,
      tags: ["HQ Sample", "Sample tag"],
    };
  });
}

/** The activities a Look Ahead from `from` for `days` days shows, per day (multi-day items repeat). */
export function lookAheadDays(activities, { from = "2026-11-02", days = 60 } = {}) {
  const out = [];
  for (let d = 0; d < days; d++) {
    const dayStart = Date.parse(`${from}T00:00:00-07:00`) + d * 86_400_000; // BC is UTC−7 all year from 2026-11-01
    const dayEnd = dayStart + 86_400_000;
    const rows = activities
      .filter((a) => !(a.isConfidential && a.hqSection === "not_on_la"))
      .filter((a) => Date.parse(a.startAt) < dayEnd && Date.parse(a.endAt) >= dayStart)
      .sort((a, b) => Number(b.isAllDay) - Number(a.isAllDay) || a.startAt.localeCompare(b.startAt));
    out.push({ date: new Date(dayStart), rows });
  }
  return out;
}
