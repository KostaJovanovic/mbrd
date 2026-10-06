// The example board: what Help > Take the Tour and the board list's Example
// board open. Plain board.json data, no assets, so it costs no download and
// loadBoard() normalises it like any file. It becomes an ordinary board of the
// user's own the moment it opens - newBoard() files it, and nothing marks it.
// Its tour is the app's tour: each stop is one thing a first visit wants to know.

/** Everything sits this far below the origin, clear of the title card above it. */
const DOWN = 320;

/** One note card, `text` in the note's Markdown-flavoured form (`# ` a title). */
const note = (id: string, x: number, y: number, text: string, tint: number) =>
  ({ id, type: 'note', x, y: y - DOWN, w: 288, h: 224, rot: 0, name: '', asset: null, meta: { text, tint } });

const swatch = (id: string, x: number, hex: string) =>
  ({ id, type: 'swatch', x, y: -160 - DOWN, w: 96, h: 96, rot: 0, name: hex.toUpperCase(), asset: null, meta: { hex } });

/** A fresh copy each time, since loadBoard() takes ownership of what it is given. */
export function exampleBoard() {
  return {
    title: 'Example board',
    items: [
      { id: 'ex-fence', type: 'fence', x: 0, y: 176 - DOWN, w: 1344, h: 352, rot: 0, name: 'Start here',
        asset: null, meta: { tint: 1 } },
      note('ex-welcome', -480, 160, '# Welcome to mbrd\nA board is a wall to pin things to. This one is an ordinary board of '
        + 'your own: change it, move it about, or delete it when you are done.', 1),
      note('ex-drop', -160, 160, '# Drop anything\nPictures, video, music, PDFs, 3D models, archives and documents. '
        + 'Drag files onto the board, paste them, or use Add files.', 2),
      note('ex-move', 160, 160, '# Move around\nDrag empty space to pan, and scroll or pinch to zoom. F fits the whole '
        + 'board. S searches every command, at the pointer.', 3),
      note('ex-notes', 480, 160, '# Notes\nDouble-click a note to write in it. Paste an address to make a link card. '
        + 'Right-click anything to see what it can do.', 4),
      note('ex-colours', -480, -160, '# Colours\nA swatch holds a colour. Under Look the board can take its whole '
        + 'palette from your pictures instead.', 2),
      swatch('ex-sw-1', -256, '#b4553a'),
      swatch('ex-sw-2', -160, '#6b7f4e'),
      swatch('ex-sw-3', -64, '#d9b26f'),
      note('ex-keep', 160, -160, '# Keep a copy\nOn the web a board lives in this browser. Save it as a .mbrd file to '
        + 'keep a copy of your own. In the apps every board is already a file.', 1),
      note('ex-tours', 480, -160, '# Tours\nA tour walks someone through a board, stop by stop, as this one did. '
        + 'Build your own from the Tour button.', 3),
      { id: 'ex-star', type: 'sticker', x: 640, y: 320 - DOWN, w: 96, h: 96, rot: 8, name: 'Star', asset: null,
        meta: { shape: 's-star' } },
    ],
    connections: [['ex-colours', 'ex-sw-1']],
    tour: [
      { cards: ['ex-welcome'], caption: 'An example board, and a tour of it' },
      { cards: ['ex-drop'] },
      { cards: ['ex-move'] },
      { cards: ['ex-notes'] },
      { cards: ['ex-colours', 'ex-sw-1', 'ex-sw-2', 'ex-sw-3'] },
      { cards: ['ex-keep'] },
      { cards: ['ex-tours'], caption: 'That is the tour. The board is yours now.' },
    ],
  };
}
