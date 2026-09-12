/**
 * Generate web/assets/js/import/formats.ts from the sibling analyser repo.
 *
 *   node tools/gen-formats.mjs [path-to-analyser]
 *
 * Reads families + categories from core/formats.js, per-extension names from
 * format-page-content.mjs and proprietary-formats.js (first answer wins).
 * Output is committed — mbrd never needs the sibling repo to build or run.
 * Re-run when analyser learns a new format.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The repo has been called both names; argv[1] overrides.
const NEIGHBOURS = ['analyser', 'file-analyser'].map(n => path.resolve(HERE, '..', '..', n));
const SIBLING = process.argv[2] || NEIGHBOURS.find(dir => fs.existsSync(dir)) || NEIGHBOURS[0];
const SOURCE = path.join(SIBLING, 'web', 'assets', 'js', 'core', 'formats.js');
const PAGES = path.join(SIBLING, 'tools', 'format-page-content.mjs');
const PROPRIETARY = path.join(SIBLING, 'web', 'assets', 'js', 'renderers', 'proprietary-formats.js');
const OUT = path.resolve(HERE, '..', 'web', 'assets', 'js', 'import', 'formats.ts');

if (!fs.existsSync(SOURCE)) {
  console.error(`[gen-formats] catalog not found at ${SOURCE}`);
  console.error('[gen-formats] pass the path to the analyser repo as argv[1]');
  console.error('[gen-formats] if the path is right, run its build first - core/formats.js is compiled from src/');
  process.exit(1);
}

// Stub the DOM helper the catalog imports — we only need the data.
const src = fs.readFileSync(SOURCE, 'utf8').replace(
  /^import\s*\{[^}]*\}\s*from\s*'\.\/util\.js';?$/m,
  'const el = () => ({});'
);
const catalog = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));

const groups = catalog.catalogGrouped();

// Index-addressed: ext -> small integer instead of repeated strings.
const families = [];
const extFamily = {};
let collisions = 0;

for (const group of groups) {
  for (const row of group.rows) {
    const index = families.length;
    families.push({ label: row.label, category: group.key });
    for (const raw of row.exts) {
      const ext = String(raw).toLowerCase().replace(/^\./, '');
      if (!ext) continue;
      // First listing wins (catalog is most-specific-first).
      if (ext in extFamily) { collisions++; continue; }
      extFamily[ext] = index;
    }
  }
}

// ---------------------------------------------------------------------------
// The names
// ---------------------------------------------------------------------------

/** Load a pure-data module from the sibling, or nothing if it is not there. */
async function dataModule(file, what) {
  if (!fs.existsSync(file)) {
    console.warn(`[gen-formats] ${what} not found at ${file} - names fall back to family labels`);
    return {};
  }
  return await import(pathToFileURL(file).href);
}

const pages = (await dataModule(PAGES, 'page copy')).EXT_PAGES || {};
const proprietary = (await dataModule(PROPRIETARY, 'proprietary catalog')).FORMATS || {};

const extName = {};
const named = { pages: 0, proprietary: 0 };

const addName = (raw, name, from) => {
  const ext = String(raw || '').toLowerCase().replace(/^\./, '');
  const label = String(name || '').trim();
  if (!ext || !label || ext in extName) return;
  extName[ext] = label;
  named[from]++;
};

for (const [ext, row] of Object.entries(pages)) addName(ext, row?.name, 'pages');
for (const [ext, row] of Object.entries(proprietary)) addName(ext, row?.app, 'proprietary');

const setOf = name => [...(catalog[name] || [])].map(s => String(s).toLowerCase()).sort();

const SETS = {
  PHOTO_EXTS: setOf('PHOTO_EXTS'),
  AUDIO_EXTS: setOf('AUDIO_EXTS'),
  VIDEO_EXTS: setOf('VIDEO_EXTS'),
  CSV_EXTS: setOf('CSV_EXTS'),
  SVG_EXTS: setOf('SVG_EXTS'),
  DOC_EXTS: setOf('DOC_EXTS'),
  ARCHIVE_EXTS: setOf('ARCHIVE_EXTS'),
  HEIC_EXTS: setOf('HEIC_EXTS'),
  RAW_EXTS: setOf('RAW_EXTS'),
};

const categories = Object.fromEntries(catalog.CATEGORIES.map(c => [c.key, c.label]));

/** Wrap a long list so the generated file stays readable in a diff. */
function wrapRaw(tokens, indent = '  ') {
  const out = [];
  let line = indent;
  for (const t of tokens) {
    const token = t + ',';
    if (line.length + token.length > 96) { out.push(line); line = indent; }
    line += (line === indent ? '' : ' ') + token;
  }
  if (line.trim()) out.push(line);
  return out.join('\n');
}

const wrap = (values, indent) => wrapRaw(values.map(v => JSON.stringify(v)), indent);

const extEntries = Object.entries(extFamily).sort(([a], [b]) => (a < b ? -1 : 1));
const nameEntries = Object.entries(extName).sort(([a], [b]) => (a < b ? -1 : 1));

const body = `// GENERATED FILE - do not edit by hand.
//
// Source: analyser's core/formats.js, tools/format-page-content.mjs and
// renderers/proprietary-formats.js, lifted by tools/gen-formats.mjs.
// Re-run \`node tools/gen-formats.mjs\` to pick up newly supported formats.
//
// ${extEntries.length} extensions across ${families.length} families in ${Object.keys(categories).length} categories.
// ${nameEntries.length} extensions are named outright, a few of them ones no family claims.
// This is data only: it names what a file *is*, so an item that mbrd cannot
// draw still shows something better than "file". What mbrd can actually render
// is decided in canvas/renderers.ts, not here.

/** Category key -> human label. */
export const CATEGORIES: Record<string, string> = ${JSON.stringify(categories, null, 2)};

/** Every format family, index-addressed by the EXT_FAMILY table below. */
export const FAMILIES = [
${families.map(f => `  { label: ${JSON.stringify(f.label)}, category: ${JSON.stringify(f.category)} },`).join('\n')}
];

/** Lowercase extension (no dot) -> index into FAMILIES. Keys stay quoted:
    plenty of extensions start with a digit ("3dm", "7z") or are pure digits. */
export const EXT_FAMILY: Record<string, number> = {
${wrapRaw(extEntries.map(([ext, i]) => `${JSON.stringify(ext)}:${i}`))}
};

/**
 * What is this extension? Returns { label, category, categoryLabel } or null
 * for anything the catalog has never heard of.
 */
export function describeExt(ext: unknown) {
  const key = String(ext || '').toLowerCase().replace(/^\\./, '');
  const family = FAMILIES[EXT_FAMILY[key]];
  if (!family) return null;
  return {
    label: family.label,
    category: family.category,
    categoryLabel: CATEGORIES[family.category] || family.category,
  };
}

/** Lowercase extension (no dot) -> what that format is called. Same quoting
    rule as EXT_FAMILY, and the same reason. */
export const EXT_NAME: Record<string, string> = {
${wrapRaw(nameEntries.map(([ext, name]) => `${JSON.stringify(ext)}:${JSON.stringify(name)}`))}
};

/**
 * What to call a file with this extension, in words.
 *
 * The format's own name where there is one ("SolidWorks part", "ZIP archive"),
 * and the extension in capitals where there is not - a .qqq nobody has heard
 * of is at least a QQQ, which is more than "file" says. Empty only for an empty
 * extension, so the caller supplies the last word.
 *
 * The family label is deliberately *not* the middle step here. Four extensions
 * in the whole catalog would reach it, and what they would reach is the shelf
 * they are filed on - a .cff coming out as "Native code, ML & misc (more)"
 * reads worse than "CFF" by every measure. describeExt() is still the way to
 * ask which shelf something is on; this is the way to ask what it is.
 */
export function formatName(ext: unknown): string {
  const key = String(ext || '').toLowerCase().replace(/^\\./, '');
  if (!key) return '';
  return EXT_NAME[key] || key.toUpperCase();
}

/** Routing sets, straight from the catalog. */
${Object.entries(SETS).map(([name, list]) =>
  `export const ${name} = new Set([\n${wrap(list)}\n]);`).join('\n\n')}
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, body, 'utf8');

console.log(`[gen-formats] ${extEntries.length} extensions, ${families.length} families -> ${path.relative(process.cwd(), OUT)}`);
console.log(`[gen-formats] ${nameEntries.length} named (${named.pages} from the page copy, ${named.proprietary} from the proprietary catalog)`);
const unnamed = extEntries.filter(([ext]) => !(ext in extName)).map(([ext]) => ext);
if (unnamed.length) console.log(`[gen-formats] ${unnamed.length} extension(s) fall back to the family label: ${unnamed.join(' ')}`);
if (collisions) console.log(`[gen-formats] ${collisions} extension(s) claimed by more than one family; first listing kept`);
