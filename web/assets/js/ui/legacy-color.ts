// Script-side color-mix() fallback for engines that lack it (WebKit < 16.2).
// Reads the computed token values (which on old engines are still literal
// color-mix() text with vars resolved), evaluates them recursively, and
// writes the results as inline properties on :root. No-ops on modern engines.
// Called from ui/appearance.ts apply().

// Tokens whose computed value may be a color-mix() text (alpha-only mixes
// are already handled by @supports-not blocks in tokens.css).
const MIXED_TOKENS = [
  '--danger',
  '--note-1', '--note-2', '--note-3', '--note-4',
  '--sticker-1', '--sticker-2', '--sticker-5', '--sticker-6',
  // Harsh derives these from --accent; other tiers have plain hex.
  '--paper', '--paper-2', '--paper-3',
  '--ink', '--ink-2', '--ink-3',
  '--rule',
];

// Mixes from rule declarations (not tokens) — [name, colour, share, other].
// Share may be a token (e.g. --mobile-board-accent) read at runtime.
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

// Tokens that have a `--x-c` channel companion in tokens.css.
// tests/legacy-color.test.js holds this list and the stylesheet in sync.
const CHANNEL_TOKENS = [
  '--paper', '--paper-2', '--paper-3', '--paper-card',
  '--ink', '--ink-2', '--ink-3',
  '--rule', '--rule-2',
  '--accent', '--accent-warm', '--accent-deep', '--accent-fg',
  '--leafy', '--select',
];

// r, g, b in 0..255; a in 0..1.
type Rgba = { r: number, g: number, b: number, a: number };

let written: string[] = [];
let needed: boolean | null = null;

function lacksColorMix(): boolean {
  if (needed !== null) return needed;
  needed = typeof CSS === 'object' && typeof CSS.supports === 'function'
    ? !CSS.supports('color', 'color-mix(in srgb, red, blue)')
    : false;   // no CSS.supports at all is older than anything here targets
  return needed;
}

// Split comma-separated args respecting nested parens (Harsh nests color-mix).
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

// Parse a hex, rgb()/rgba(), `transparent`, or nested color-mix().
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

  // rgb() with commas or space+slash syntax.
  const parts = args(fn[2]).length > 1 ? args(fn[2]) : fn[2].trim().split(/\s*\/\s*|\s+/);
  const nums = parts.slice(0, 3).map(p => parseFloat(p));
  if (nums.some(n => Number.isNaN(n))) return null;
  const rawA = parts[3];
  const a = rawA === undefined ? 1
    : rawA.trim().endsWith('%') ? parseFloat(rawA) / 100 : parseFloat(rawA);
  return { r: nums[0], g: nums[1], b: nums[2], a: Number.isNaN(a) ? 1 : a };
}

// Evaluate a color-mix() inner text. Premultiplied alpha mixing.
// Interpolation space is read and ignored (srgb ≈ oklab at these shares).
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

// Evaluate and write all derived colours. Reads all before writing to avoid
// order-dependent resolution (setting --paper would change --paper-2 mid-run).
export function legacyBlends(root: HTMLElement): void {
  if (!lacksColorMix()) return;

  for (const name of written) root.style.removeProperty(name);
  written = [];

  const style = getComputedStyle(root);
  const read = (name: string) => style.getPropertyValue(name).trim();

  // Skip tokens already resolved to a colour (modern engine or hand-set).
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

  // Retake channel forms from the resolved colours — a dynamic accent (from a
  // photo or picker) would otherwise leave stale named-palette channels.
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
  // Channel form is three numbers for rgb(... / N%).
  for (const [name, { r, g, b }] of channels) {
    const n = (x: number) => Math.max(0, Math.min(255, Math.round(x)));
    root.style.setProperty(name, `${n(r)} ${n(g)} ${n(b)}`);
    written.push(name);
  }
}

// Exposed for tests.
export const _internals = { parse, evaluate, css, args, BLENDS, MIXED_TOKENS, CHANNEL_TOKENS };
