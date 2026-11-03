/**
 * Given names for fictional people, common enough to read naturally and paired with invented surnames below.
 * Wide on purpose: a person's slot picks the given name evenly, so a short list gives a staff list of hundreds
 * the same few names over and over (80 names left about 130 people sharing each).
 */
export const FIRST_NAMES = [
  "Alex", "Avery", "Blair", "Cameron", "Casey", "Dana", "Devon", "Drew", "Eden", "Ellis",
  "Emerson", "Finley", "Harper", "Hayden", "Jamie", "Jesse", "Jordan", "Jules", "Kai", "Kendall",
  "Logan", "Marley", "Morgan", "Noel", "Oakley", "Parker", "Peyton", "Quinn", "Reese", "Remy",
  "Riley", "Robin", "Rowe", "Sam", "Shay", "Sidney", "Skyler", "Stevie", "Sutton", "Tatum",
  "Taylor", "Teagan", "Toby", "Val", "Ari", "Cass", "Dale", "Eli", "Fran", "Glen",
  "Hollis", "Isa", "Kit", "Mel", "Nico", "Ollie", "Pat", "Rae", "Sol", "Tali",
  "Uma", "Vic", "Wynn", "Zane", "Brook", "Cody", "Darby", "Emery", "Frankie", "Gale",
  "Hart", "Indy", "Jody", "Kerry", "Lane", "Milan", "Nova", "Orrin", "Perry", "Rory",
  "Aaron", "Abby", "Adam", "Adrian", "Aidan", "Aisha", "Alana", "Albert", "Alicia", "Alison",
  "Amar", "Amber", "Amelia", "Amir", "Amy", "Ananya", "Andre", "Andrea", "Angela", "Anika",
  "Anna", "Anton", "Arjun", "Audrey", "Austin", "Ben", "Bianca", "Bonnie", "Brandon", "Brenda",
  "Brent", "Brianna", "Bruce", "Caleb", "Carla", "Carmen", "Carol", "Catherine", "Chantal", "Charles",
  "Chloe", "Chris", "Claire", "Colin", "Connor", "Craig", "Crystal", "Daniel", "Darren", "David",
  "Deborah", "Deepak", "Denise", "Derek", "Diana", "Dimitri", "Dominic", "Donna", "Dylan", "Elena",
  "Elise", "Emma", "Eric", "Erin", "Ethan", "Eva", "Evan", "Faith", "Farah", "Felix",
  "Fiona", "Gavin", "Gemma", "Georgia", "Gordon", "Grace", "Graham", "Greg", "Hana", "Hannah",
  "Harjit", "Heather", "Helen", "Henry", "Holly", "Hugo", "Ian", "Imani", "Ines", "Iris",
  "Isaac", "Ivan", "Jack", "Jacob", "Jade", "Jason", "Jasmine", "Jasper", "Jean", "Jenna",
  "Jeremy", "Jill", "Joanne", "Joel", "John", "Jonah", "Joseph", "Josh", "Joy", "Julia",
  "Justin", "Kamal", "Karen", "Karim", "Kate", "Keira", "Kevin", "Kim", "Kiran", "Kyle",
  "Laura", "Lauren", "Leah", "Leila", "Leo", "Liam", "Lila", "Linda", "Lisa", "Lucas",
  "Lucy", "Luis", "Lydia", "Mackenzie", "Madeline", "Maya", "Malcolm", "Manpreet", "Marco", "Maria",
  "Mark", "Martin", "Mateo", "Matthew", "Megan", "Mei", "Michelle", "Miguel", "Mira", "Mohammed",
  "Monica", "Naomi", "Natalie", "Nathan", "Navdeep", "Neil", "Nina", "Nolan", "Nora", "Olivia",
  "Omar", "Owen", "Paige", "Paolo", "Paula", "Peter", "Philip", "Priya", "Rachel", "Rahul",
  "Rajan", "Ravi", "Rebecca", "Renee", "Ricardo", "Rita", "Rohan", "Ruby", "Ryan", "Sabrina",
  "Samira", "Sandra", "Sara", "Sean", "Simran", "Sofia", "Sonia", "Stephen", "Susan", "Tamara",
  "Tara", "Theo", "Thomas", "Tina", "Trevor", "Tyler", "Vanessa", "Vikram", "Victoria", "Vincent",
  "Wei", "Wendy", "Will", "Xavier", "Yasmin", "Yuki", "Yusuf", "Zara", "Zoe", "Zoran",
  "Akira", "Alain", "Bea", "Celeste", "Dario", "Esme", "Fatima", "Gita", "Hamid", "Ilse",
  "Jonas", "Kenji", "Lena", "Mateus", "Nadia", "Oscar", "Pia", "Rana", "Soren", "Tomas",
] as const;

const STEMS = [
  "Ash", "Birch", "Cedar", "Alder", "Briar", "Fern", "Heath", "Larch", "Maple", "Rowan",
  "Thistle", "Willow", "Hazel", "Juniper", "Moss", "Reed", "Sorrel", "Tansy", "Yarrow", "Clover",
  "Bramble", "Elder", "Holly", "Linden", "Myrtle", "Quince", "Sedge", "Teasel", "Vetch", "Wren",
  "Aspen", "Bay", "Bracken", "Broom", "Burdock", "Camas", "Chicory", "Cypress", "Dogwood", "Fir",
  "Gorse", "Hawthorn", "Hemlock", "Ivy", "Laurel", "Lupin", "Madrona", "Mallow", "Nettle", "Oak",
  "Pine", "Poplar", "Rush", "Salal", "Sage", "Spruce", "Sumac", "Tamarack", "Thorn", "Yew",
] as const;
const ENDINGS = ["field", "wood", "brook", "ford", "ley", "ton", "more", "dale", "croft", "well", "by", "stead", "hurst", "shaw", "combe", "wick"] as const;
/** Invented surnames: plant names joined to place-name endings. */
export const SURNAMES: readonly string[] = STEMS.flatMap((s) => ENDINGS.map((e) => `${s}${e}`));
