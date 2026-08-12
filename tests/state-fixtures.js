// The item shapes and the board reset every state case starts from.
//
// Extracted when tests/state.test.js was split into six files: each of them
// opens an empty board in a beforeEach, and each builds the same three kinds of
// card. Kept out of helpers.js because these know about state.js, which the
// rest of helpers.js deliberately does not.

import { loadBoard } from '../web/assets/js/state.js';

/** An empty board, through the same door opening a .mbrd goes through. */
export const fresh = (items = []) => loadBoard({ title: 'T', items });

export const note = (props = {}) => ({ type: 'note', w: 100, h: 100, meta: { text: 'n' }, ...props });
export const photo = (props = {}) => ({ type: 'image', w: 200, h: 200, ...props });
export const clip = (props = {}) => ({ type: 'video', w: 288, h: 162, ...props });
export const fence = (props = {}) => ({ type: 'fence', w: 800, h: 600, name: 'F', ...props });
export const sticker = (props = {}) => ({ type: 'sticker', w: 96, h: 96, name: 'Star', meta: { shape: 's-star', tint: 2 }, ...props });
