// Starter layouts: empty boards with a structure to fill - a moodboard's
// sections, a character sheet, a project brief, a reference grid. Titled
// fences and nothing in them, as plain board.json data like the example board
// (example.ts), so loadBoard() normalises them and they cost no download. The
// board list offers them beside the example board, and each opens as an
// ordinary board of the user's own.

/** Everything sits this far below the origin, clear of the title card above it. */
const DOWN = 320;
const GAP = 48;

/** A fence per section, `cols` across, row by row under the title card. */
function fences(prefix: string, cols: number, names: string[], w = 640, h = 480) {
  const width = cols * w + (cols - 1) * GAP;
  return names.map((name, i) => ({
    id: `${prefix}-${i}`, type: 'fence',
    x: -width / 2 + (i % cols) * (w + GAP) + w / 2,
    // World y runs up: each row lower than the last.
    y: -DOWN - Math.floor(i / cols) * (h + GAP) - h / 2,
    w, h, rot: 0, name, asset: null,
    // The four fence tints in turn, so neighbours are told apart.
    meta: { tint: (i % 4) + 1 },
  }));
}

export type Starter = { id: string, label: string, hint: string, board: () => Record<string, unknown> };

/** A fresh copy each time, since loadBoard() takes ownership of what it is given. */
export const STARTERS: Starter[] = [
  {
    id: 'moodboard', label: 'Moodboard',
    hint: 'Mood, colour, type, texture and references, a fence each',
    board: () => ({
      title: 'Moodboard',
      items: fences('mood', 3, ['Mood', 'Colour', 'Type', 'Texture', 'References', 'Anything else']),
    }),
  },
  {
    id: 'character', label: 'Character sheet',
    hint: 'Face, figure, costume, poses, palette and props',
    board: () => ({
      title: 'Character sheet',
      items: fences('char', 3, ['Face', 'Figure', 'Costume', 'Poses', 'Palette', 'Props'], 560, 560),
    }),
  },
  {
    id: 'brief', label: 'Project brief',
    hint: 'Goal, audience, references, constraints, deliverables and timeline',
    board: () => ({
      title: 'Project brief',
      items: fences('brief', 2,
        ['Goal', 'Audience', 'References', 'Constraints', 'Deliverables', 'Timeline'], 800, 400),
    }),
  },
  {
    id: 'grid', label: 'Reference grid',
    hint: 'Nine fences by what a reference is for: light, composition, colour and the rest',
    board: () => ({
      title: 'Reference grid',
      items: fences('grid', 3, ['Light', 'Composition', 'Colour', 'Texture', 'Form', 'Detail',
        'Mood', 'Setting', 'Anything else'], 480, 480),
    }),
  },
];
