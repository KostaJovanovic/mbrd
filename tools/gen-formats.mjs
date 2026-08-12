/**
 * Generate web/assets/js/import/formats.ts from the sibling file-analyser repo.
 *
 *   node tools/gen-formats.mjs [path-to-file-analyser]
 *
 * file-analyser keeps a hand-curated catalog of ~1350 file extensions in
 * core/formats.js - what each one is, which family it belongs to, which
 * category that family sits in. mbrd wants the *data* (so a dropped .sldprt
 * says "SolidWorks / 3D & CAD" instead of "file"), but not the code around it:
 * every renderer over there builds an analysis report and is wired to that
 * app's DOM helpers and CSS. So we lift the catalog and leave the rest.
 *
 * Re-run this whenever file-analyser learns a new format. The output is
 * committed, so mbrd never needs the sibling repo present to build or run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIBLING = process.argv[2] || path.resolve(HERE, '..', '..', 'file-analyser');
const SOURCE = path.join(SIBLING, 'web', 'assets', 'js', 'core', 'formats.js');
const OUT = path.resolve(HERE, '..', 'web', 'assets', 'js', 'import', 'formats.ts');

if (!fs.existsSync(SOURCE)) {
  console.error(`[gen-formats] catalog not found at ${SOURCE}`);
  console.error('[gen-formats] pass the path to the file-analyser repo as argv[1]');
  process.exit(1);
}

// The catalog module's only dependency is one DOM helper it uses in the render
// functions we don't call. Stub it out and the rest evaluates as pure data.
const src = fs.readFileSync(SOURCE, 'utf8').replace(
  /^import\s*\{[^}]*\}\s*from\s*'\.\/util\.js';?$/m,
  'const el = () => ({});'
);
const catalog = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));

const groups = catalog.catalogGrouped();

// families[] is index-addressed so the ext -> family map can be a flat table of
// small integers instead of 1350 repeated strings.
const families = [];
const extFamily = {};
let collisions = 0;

for (const group of groups) {
  for (const row of group.rows) {
    const index = families.length;
    families.push({ label: row.label, category: group.key, slug: row.slug });
    for (const raw of row.exts) {
      const ext = String(raw).toLowerCase().replace(/^\./, '');
      if (!ext) continue;
      // First listing wins: the catalog is ordered most-specific-first, so an
      // ext claimed by both "Photo" and some niche family stays a photo.
      if (ext in extFamily) { collisions++; continue; }
      extFamily[ext] = index;
    }
  }
}

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

const body = `// GENERATED FILE - do not edit by hand.
//
// Source: file-analyser's core/formats.js, lifted by tools/gen-formats.mjs.
// Re-run \`node tools/gen-formats.mjs\` to pick up newly supported formats.
//
// ${extEntries.length} extensions across ${families.length} families in ${Object.keys(categories).length} categories.
// This is data only: it names what a file *is*, so an item that mbrd cannot
// draw still shows something better than "file". What mbrd can actually render
// is decided in canvas/renderers.js, not here.

/** Category key -> human label. */
export const CATEGORIES = ${JSON.stringify(categories, null, 2)};

/** Every format family, index-addressed by the EXT_FAMILY table below. */
export const FAMILIES = [
${families.map(f => `  { label: ${JSON.stringify(f.label)}, category: ${JSON.stringify(f.category)} },`).join('\n')}
];

/** Lowercase extension (no dot) -> index into FAMILIES. Keys stay quoted:
    plenty of extensions start with a digit ("3dm", "7z") or are pure digits. */
export const EXT_FAMILY = {
${wrapRaw(extEntries.map(([ext, i]) => `${JSON.stringify(ext)}:${i}`))}
};

/**
 * What is this extension? Returns { label, category, categoryLabel } or null
 * for anything the catalog has never heard of.
 */
export function describeExt(ext) {
  const key = String(ext || '').toLowerCase().replace(/^\\./, '');
  const family = FAMILIES[EXT_FAMILY[key]];
  if (!family) return null;
  return {
    label: family.label,
    category: family.category,
    categoryLabel: CATEGORIES[family.category] || family.category,
  };
}

/** Routing sets, straight from the catalog. */
${Object.entries(SETS).map(([name, list]) =>
  `export const ${name} = new Set([\n${wrap(list)}\n]);`).join('\n\n')}
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, body, 'utf8');

console.log(`[gen-formats] ${extEntries.length} extensions, ${families.length} families -> ${path.relative(process.cwd(), OUT)}`);
if (collisions) console.log(`[gen-formats] ${collisions} extension(s) claimed by more than one family; first listing kept`);
