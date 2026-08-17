/**
 * The colours CSS cannot mix here, mixed in script.
 *
 * WebKit got color-mix() in 16.2. Section 7 of tokens.css carries the argument
 * for the fallback and does most of the work: ninety-nine of the app's hundred
 * and forty-one mixes are `color-mix(in srgb, C N%, transparent)`, which is not
 * a mix at all but C at N% alpha, and those are spelled `rgb(var(--C-c) / N%)`
 * inside an `@supports not` block that a current browser skips whole.
 *
 * This module is the remainder: the mixes of two real pigments, which have no
 * rgb() spelling and - this is the part that rules out precomputing them into
 * the stylesheet - no value that can be written down at all. Harsh derives its
 * entire sheet from --accent:
 *
 *     --paper: color-mix(in srgb, var(--accent) 4%, var(--stock));
 *     --ink:   color-mix(in srgb, var(--accent) 13%, #000);
 *
 * and --accent may be a pigment ui/pigments.js pulled out of a photograph the
 * board is wearing, or one somebody picked in the Appearance panel a second ago.
 * There is no set of four palettes to precompute; there is a function of a
 * colour that is not known until it is known.
 *
 * ## What it does not do
 *
 * It does not carry a copy of the recipes. That was the first design and it was
 * wrong: a table here saying `--paper is 4% accent into stock` is the same
 * sentence tokens.css already says, in a second place, and CLAUDE.md is right
 * about what happens to those. It reads the recipe out of the stylesheet
 * instead.
 *
 * That works because of how an unregistered custom property computes. The
 * engine cannot parse color-mix(), but it never tries: a custom property holds
 * a token sequence, and its *computed* value is that sequence with every var()
 * already substituted. So on the browser this is for, asking for --paper-3 at
 * Harsh hands back
 *
 *     color-mix(in srgb,
 *       color-mix(in srgb, #b94900 13%, #000) 9%,
 *       color-mix(in srgb, #b94900 4%, #fafbfc))
 *
 * - the whole derivation, already resolved down to literals, nested exactly as
 * the stylesheet wrote it. A recursive evaluator over that text needs to know
 * nothing about what the tokens mean. Change a recipe in tokens.css and this
 * follows without being told.
 *
 * ## The one table
 *
 * BLENDS is the exception and it is unavoidable. Those mixes are written into
 * rule declarations rather than into tokens - `.pl-cover { background:
 * color-mix(in srgb, var(--accent) 12%, var(--paper-3)) }` - and a declaration
 * inside a rule the engine has already thrown away cannot be read back. So the
 * fallback rules in mobile.css, ghosts.css and canvas.css name a --lc-* token
 * each, and these are the recipes for them. tests/legacy-color.test.js holds
 * every entry against the color-mix() it mirrors, in both directions, so one
 * moving without the other fails rather than drifting.
 *
 * ## Scope
 *
 * Writes inline properties on :root, which is where ui/appearance.js writes a
 * hand-picked pigment too - and inline is the one place nothing in a stylesheet
 * can outrank. Two rules keep the two out of each other's way. A token is only
 * written if its computed value *was* a color-mix, so a colour somebody chose
 * by hand is already a colour and is left exactly alone. And everything written
 * is cleared at the top of the next run, so nothing survives the move that made
 * it wrong. The --lc-* namespace has no other author.
 *
 * Called from apply() in ui/appearance.js, which is the single funnel every
 * change of look goes through - palette, whimsy, a board arriving with its own
 * colours, the panel, the boot. On any engine with color-mix() the first line
 * of run() returns and nothing below it ever executes.
 */

/**
 * Tokens declared as a two-colour mix somewhere in tokens.css.
 *
 * The alpha-only tokens are deliberately absent: `@supports not` in tokens.css
 * already restates every one of those in rgb() channel form, which is exact and
 * needs no script. These are the ones left over.
 *
 * A name costs nothing when the tier it belongs to is not the current one -
 * read() finds an ordinary colour and skips it - so the list is flat rather
 * than split by whimsy level.
 */
const MIXED_TOKENS = [
  '--danger',
  '--note-1', '--note-2', '--note-3', '--note-4',
  '--sticker-1', '--sticker-2', '--sticker-5', '--sticker-6',
  // Harsh derives the sheet and the ink themselves, so these carry a mix at
  // that level and a plain hex at the other two.
  '--paper', '--paper-2', '--paper-3',
  '--ink', '--ink-2', '--ink-3',
  '--rule',
];

/**
 * The mixes written into rule declarations rather than into tokens.
 *
 * Each is `[name, colour, share, other]`, and the fallback rule that reads it
 * is named beside it. The share is a percentage, or a token holding one - the
 * board frame's share is a value the whimsy axis moves, so it is read at the
 * same time as the colours rather than fixed here.
 */
const BLENDS: [string, string, string, string][] = [
  // ghosts.css
  ['--lc-accent-88-ink',       '--accent', '88%', '--ink'],
  // canvas.css - the share is --mobile-board-accent, 6% / 7% / 4.5% by tier.
  ['--lc-mobile-board',        '--accent', '--mobile-board-accent', '#fff'],
  // mobile.css
  ['--lc-ink-6-paper',         '--ink',    '6%',  '--paper'],
  ['--lc-accent-6-white',      '--accent', '6%',  '#fff'],
  ['--lc-accent-10-paper-3',   '--accent', '10%', '--paper-3'],
  ['--lc-accent-12-paper-3',   '--accent', '12%', '--paper-3'],
  ['--lc-accent-9-paper-2',    '--accent', '9%',  '--paper-2'],
  ['--lc-accent-14-paper-2',   '--accent', '14%', '--paper-2'],
  ['--lc-accent-10-paper-card', '--accent', '10%', '--paper-card'],
  ['--lc-accent-14-paper-card', '--accent', '14%', '--paper-card'],
  ['--lc-accent-58-ink-3',     '--accent', '58%', '--ink-3'],
  ['--lc-accent-65-ink-3',     '--accent', '65%', '--ink-3'],
  ['--lc-accent-70-ink-3',     '--accent', '70%', '--ink-3'],
  ['--lc-ink-2-75-accent',     '--ink-2',  '75%', '--accent'],
];

/**
 * The colours that carry a `--x-c` channel companion in tokens.css.
 *
 * Same list, same order, and tests/legacy-color.test.js holds the two together
 * in both directions - a pigment that gains a channel token in the stylesheet
 * and not here keeps the named palette's value through a recolour, which reads
 * as the accent moving and its own tints staying put.
 */
const CHANNEL_TOKENS = [
  '--paper', '--paper-2', '--paper-3', '--paper-card',
  '--ink', '--ink-2', '--ink-3',
  '--rule', '--rule-2',
  '--accent', '--accent-warm', '--accent-deep', '--accent-fg',
  '--leafy', '--select',
];

/** Red, green, blue in 0..255 and alpha in 0..1. */
type Rgba = { r: number, g: number, b: number, a: number };

/** Everything this module has written, so the next run can take it back. */
let written: string[] = [];

/** Whether this engine needs any of it. Asked once - it cannot change. */
let needed: boolean | null = null;

function lacksColorMix(): boolean {
  if (needed !== null) return needed;
  needed = typeof CSS === 'object' && typeof CSS.supports === 'function'
    ? !CSS.supports('color', 'color-mix(in srgb, red, blue)')
    : false;   // no CSS.supports at all is older than anything here targets
  return needed;
}

/**
 * Split a comma-separated argument list, respecting nesting.
 *
 * The nesting is the whole reason this is not `split(',')`: at Harsh every
 * argument is itself a color-mix() with two commas of its own.
 */
function args(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map(s => s.trim());
}

/** A hex, an rgb()/rgba(), `transparent`, or a nested color-mix(). */
function parse(text: string): Rgba | null {
  const value = text.trim();
  if (!value) return null;
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (value === '#fff' || value === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (value === '#000' || value === 'black') return { r: 0, g: 0, b: 0, a: 1 };

  if (value.startsWith('#')) {
    const hex = value.slice(1);
    const wide = hex.length >= 6;
    const step = wide ? 2 : 1;
    if (hex.length !== 3 && hex.length !== 4 && hex.length !== 6 && hex.length !== 8) return null;
    const at = (i: number) => {
      const part = hex.substr(i * step, step);
      const n = parseInt(wide ? part : part + part, 16);
      return Number.isNaN(n) ? null : n;
    };
    const r = at(0), g = at(1), b = at(2);
    if (r === null || g === null || b === null) return null;
    const alpha = hex.length === 4 || hex.length === 8 ? at(3) : 255;
    return { r, g, b, a: (alpha === null ? 255 : alpha) / 255 };
  }

  const fn = value.match(/^(rgba?|color-mix)\s*\(([\s\S]*)\)$/i);
  if (!fn) return null;
  if (fn[1].toLowerCase() === 'color-mix') return evaluate(fn[2]);

  // rgb() in either spelling: commas, or spaces with a slashed alpha.
  const parts = args(fn[2]).length > 1 ? args(fn[2]) : fn[2].trim().split(/\s*\/\s*|\s+/);
  const nums = parts.slice(0, 3).map(p => parseFloat(p));
  if (nums.some(n => Number.isNaN(n))) return null;
  const rawA = parts[3];
  const a = rawA === undefined ? 1
    : rawA.trim().endsWith('%') ? parseFloat(rawA) / 100 : parseFloat(rawA);
  return { r: nums[0], g: nums[1], b: nums[2], a: Number.isNaN(a) ? 1 : a };
}

/**
 * The inside of a color-mix(), as `in <space>, A p%, B`.
 *
 * Mixing is done on premultiplied values, which is what makes the alpha-only
 * case in tokens.css an identity rather than an approximation, and it is the
 * only part of this that is not obvious - so it is done properly here too even
 * though the pairs this module sees are almost always both opaque.
 *
 * The interpolation space is read and then ignored. Three mixes in the app ask
 * for oklab and all three are alpha-only, so they never reach this function;
 * were one to, srgb and oklab differ by less than the rounding to a byte at the
 * shares in use, and getting it wrong on a browser this old is not worth a
 * colour-space conversion nobody would see.
 */
function evaluate(inner: string): Rgba | null {
  const parts = args(inner);
  if (parts.length < 3) return null;
  if (!/^in\s+/i.test(parts[0])) return null;

  const first = parts[1].match(/^([\s\S]+?)\s+([\d.]+)%$/);
  const second = parts[2].match(/^([\s\S]+?)\s+([\d.]+)%$/);
  if (!first && !second) return null;

  const a = parse(first ? first[1] : parts[1]);
  const b = parse(second ? second[1] : parts[2]);
  if (!a || !b) return null;

  let pa = first ? parseFloat(first[2]) / 100 : NaN;
  const pb = second ? parseFloat(second[2]) / 100 : NaN;
  if (Number.isNaN(pa)) pa = Number.isNaN(pb) ? 0.5 : 1 - pb;
  pa = Math.max(0, Math.min(1, pa));
  const alpha = a.a * pa + b.a * (1 - pa);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  // Premultiply, mix, un-premultiply.
  const channel = (x: number, y: number) =>
    (x * a.a * pa + y * b.a * (1 - pa)) / alpha;
  return {
    r: channel(a.r, b.r),
    g: channel(a.g, b.g),
    b: channel(a.b, b.b),
    a: alpha,
  };
}

function css({ r, g, b, a }: Rgba): string {
  const n = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
  return a >= 1
    ? `rgb(${n(r)} ${n(g)} ${n(b)})`
    : `rgb(${n(r)} ${n(g)} ${n(b)} / ${Math.round(a * 1000) / 10}%)`;
}

/**
 * Work out every derived colour and write it, or do nothing at all.
 *
 * Reads are taken in full before the first write, which is what keeps the run
 * consistent: setting --paper would otherwise change what --paper-2 resolves to
 * halfway through, and the answer would depend on the order of a list.
 */
export function legacyBlends(root: HTMLElement): void {
  if (!lacksColorMix()) return;

  for (const name of written) root.style.removeProperty(name);
  written = [];

  const style = getComputedStyle(root);
  const read = (name: string) => style.getPropertyValue(name).trim();

  // A token whose value is already a colour is one this browser can read, or
  // one somebody set by hand. Either way it is not ours.
  const fixups: [string, Rgba][] = [];
  for (const name of MIXED_TOKENS) {
    const raw = read(name);
    if (!raw.toLowerCase().startsWith('color-mix')) continue;
    const value = parse(raw);
    if (value) fixups.push([name, value]);
  }

  const colour = (term: string): Rgba | null =>
    parse(term.startsWith('--') ? read(term) : term);

  const blends: [string, Rgba][] = [];
  for (const [name, a, share, b] of BLENDS) {
    const from = colour(a);
    const to = colour(b);
    if (!from || !to) continue;
    const pct = share.startsWith('--') ? read(share) : share;
    const p = parseFloat(pct);
    if (Number.isNaN(p)) continue;
    const q = Math.max(0, Math.min(1, p / 100));
    const alpha = from.a * q + to.a * (1 - q);
    if (alpha === 0) continue;
    const channel = (x: number, y: number) => (x * from.a * q + y * to.a * (1 - q)) / alpha;
    blends.push([name, {
      r: channel(from.r, to.r),
      g: channel(from.g, to.g),
      b: channel(from.b, to.b),
      a: alpha,
    }]);
  }

  // And the channel forms, retaken from whatever the colours actually are now.
  //
  // tokens.css declares these for the four named palettes, which is what the
  // first paint needs and is as far as a stylesheet can go. It cannot cover the
  // two cases that matter most: a pigment somebody picked in the Appearance
  // panel, and a palette ui/pigments.js pulled out of a photograph. Both are
  // written inline as --accent and nothing else, so --accent-c would still be
  // the named palette's - and every alpha-only fallback in the app reads the
  // channel form. The accent would move and its own tint would not follow it.
  //
  // Retaking them from the resolved colour costs nothing and closes that: the
  // stylesheet's values are the default, and after this they are the truth.
  const channels: [string, Rgba][] = [];
  const fixed = new Map(fixups);
  for (const name of CHANNEL_TOKENS) {
    const value = fixed.get(name) || parse(read(name));
    if (value) channels.push([`${name}-c`, value]);
  }

  for (const [name, value] of fixups.concat(blends)) {
    root.style.setProperty(name, css(value));
    written.push(name);
  }
  // Channel form is three numbers, not a colour: it goes into rgb(... / N%).
  for (const [name, { r, g, b }] of channels) {
    const n = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
    root.style.setProperty(name, `${n(r)} ${n(g)} ${n(b)}`);
    written.push(name);
  }
}

/** For the test, which has no browser to ask. */
export const _internals = { parse, evaluate, css, args, BLENDS, MIXED_TOKENS, CHANNEL_TOKENS };
