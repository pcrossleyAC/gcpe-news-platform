/** Given names for fictional people. Common enough to read naturally, paired with invented surnames below. */
export const FIRST_NAMES = [
  "Alex", "Avery", "Blair", "Cameron", "Casey", "Dana", "Devon", "Drew", "Eden", "Ellis",
  "Emerson", "Finley", "Harper", "Hayden", "Jamie", "Jesse", "Jordan", "Jules", "Kai", "Kendall",
  "Logan", "Marley", "Morgan", "Noel", "Oakley", "Parker", "Peyton", "Quinn", "Reese", "Remy",
  "Riley", "Robin", "Rowe", "Sam", "Shay", "Sidney", "Skyler", "Stevie", "Sutton", "Tatum",
  "Taylor", "Teagan", "Toby", "Val", "Ari", "Cass", "Dale", "Eli", "Fran", "Glen",
  "Hollis", "Isa", "Kit", "Mel", "Nico", "Ollie", "Pat", "Rae", "Sol", "Tali",
  "Uma", "Vic", "Wynn", "Zane", "Brook", "Cody", "Darby", "Emery", "Frankie", "Gale",
  "Hart", "Indy", "Jody", "Kerry", "Lane", "Milan", "Nova", "Orrin", "Perry", "Rory",
] as const;

const STEMS = ["Ash", "Birch", "Cedar", "Alder", "Briar", "Fern", "Heath", "Larch", "Maple", "Rowan", "Thistle", "Willow", "Hazel", "Juniper", "Moss", "Reed", "Sorrel", "Tansy", "Yarrow", "Clover", "Bramble", "Elder", "Holly", "Linden", "Myrtle", "Quince", "Sedge", "Teasel", "Vetch", "Wren"] as const;
const ENDINGS = ["field", "wood", "brook", "ford", "ley", "ton", "more", "dale", "croft", "well"] as const;
/** Invented surnames: plant names joined to place-name endings. */
export const SURNAMES: readonly string[] = STEMS.flatMap((s) => ENDINGS.map((e) => `${s}${e}`));
