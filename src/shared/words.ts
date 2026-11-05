// Word deck the clue-giver can draw from. Words are plain A–Z, 4–10 letters,
// and concrete enough to clue letter by letter.

export interface Category {
  id: string;
  label: string;
  words: readonly string[];
}

export const CATEGORIES: readonly Category[] = [
  {
    id: 'animals',
    label: 'Animals',
    words: [
      'otter', 'falcon', 'giraffe', 'penguin', 'octopus', 'hedgehog', 'panther', 'beaver',
      'lobster', 'flamingo', 'squirrel', 'walrus', 'gorilla', 'jaguar', 'pelican', 'raccoon',
      'tortoise', 'dolphin', 'buffalo', 'chameleon', 'kangaroo', 'peacock', 'hamster', 'badger',
      'camel', 'koala', 'zebra', 'moose', 'lizard', 'parrot', 'spider', 'whale',
    ],
  },
  {
    id: 'food',
    label: 'Food',
    words: [
      'biryani', 'pancake', 'avocado', 'noodles', 'pretzel', 'mango', 'samosa', 'waffle',
      'pickle', 'burrito', 'cupcake', 'popcorn', 'lasagna', 'coconut', 'pumpkin', 'dumpling',
      'omelette', 'cinnamon', 'pistachio', 'broccoli', 'sandwich', 'doughnut', 'pineapple', 'yogurt',
      'cheese', 'paneer', 'tomato', 'garlic', 'muffin', 'cookie', 'lemonade', 'brownie',
    ],
  },
  {
    id: 'places',
    label: 'Places',
    words: [
      'library', 'airport', 'volcano', 'museum', 'harbour', 'desert', 'castle', 'jungle',
      'stadium', 'temple', 'bakery', 'island', 'glacier', 'hospital', 'theatre', 'canyon',
      'lighthouse', 'pharmacy', 'aquarium', 'factory', 'bazaar', 'village', 'station', 'circus',
      'garden', 'school', 'market', 'beach', 'cinema', 'prison', 'palace', 'tunnel',
    ],
  },
  {
    id: 'things',
    label: 'Things',
    words: [
      'umbrella', 'compass', 'trumpet', 'blanket', 'scissors', 'keyboard', 'lantern', 'mirror',
      'backpack', 'hammock', 'kettle', 'telescope', 'balloon', 'ladder', 'magnet', 'candle',
      'whistle', 'pillow', 'helmet', 'anchor', 'wallet', 'puzzle', 'rocket', 'bicycle',
      'guitar', 'camera', 'basket', 'teapot', 'button', 'violin', 'trophy', 'zipper',
    ],
  },
  {
    id: 'actions',
    label: 'Actions',
    words: [
      'juggle', 'whisper', 'sneeze', 'dance', 'giggle', 'wander', 'scribble', 'tumble',
      'paddle', 'gallop', 'shiver', 'bounce', 'snore', 'climb', 'sprint', 'knit',
      'bake', 'swim', 'yawn', 'skate', 'paint', 'sing', 'cheer', 'float',
      'stretch', 'wink', 'hiccup', 'surf', 'travel', 'gossip', 'wrestle', 'tickle',
    ],
  },
  {
    id: 'nature',
    label: 'Nature',
    words: [
      'thunder', 'rainbow', 'meadow', 'blossom', 'pebble', 'tornado', 'monsoon', 'sunrise',
      'orchid', 'cactus', 'avalanche', 'lagoon', 'comet', 'galaxy', 'eclipse', 'waterfall',
      'mushroom', 'acorn', 'feather', 'iceberg', 'lightning', 'puddle', 'bamboo', 'coral',
      'forest', 'planet', 'river', 'storm', 'sunflower', 'tulip', 'breeze', 'snowflake',
    ],
  },
];

export function drawWords(categoryId: string | null, count: number, rand = Math.random): string[] {
  const pool = categoryId
    ? (CATEGORIES.find((c) => c.id === categoryId)?.words ?? [])
    : CATEGORIES.flatMap((c) => c.words);
  const copy = [...pool];
  const out: string[] = [];
  while (out.length < count && copy.length > 0) {
    out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  }
  return out;
}
