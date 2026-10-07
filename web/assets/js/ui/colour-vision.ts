// Colourblind mode: per device, never in a board. Two choices, both on <html>.
// data-cvd remaps what the interface says by colour (tokens.css section 8,
// canvas.css, status.css) and names the colour on every swatch (items.css);
// data-cvd-sim shows the board as somebody with that kind of vision sees it,
// through an SVG filter this module puts in the page, to check a board by.

import { readPref, writePref } from '../prefs.ts';

export type Vision = '' | 'deutan' | 'protan' | 'tritan';

export const VISIONS: readonly { value: Vision, label: string }[] = [
  { value: '', label: 'As drawn' },
  { value: 'deutan', label: 'Deuteranopia (red-green)' },
  { value: 'protan', label: 'Protanopia (red-green)' },
  { value: 'tritan', label: 'Tritanopia (blue-yellow)' },
];

const KEY = 'mbrd.vision';
const SIM_KEY = 'mbrd.vision.simulate';

const asVision = (v: unknown): Vision =>
  VISIONS.find(o => o.value === v)?.value ?? '';

/** The colours the interface is drawn in, for this kind of vision. */
export const visionMode = (): Vision => asVision(readPref(KEY, ''));
/** The vision the board is shown through, '' for as it is. */
export const visionSimulated = (): Vision => asVision(readPref(SIM_KEY, ''));

export function setVisionMode(v: string) {
  writePref(KEY, asVision(v));
  paint();
}

export function setVisionSimulated(v: string) {
  writePref(SIM_KEY, asVision(v));
  paint();
}

/**
 * Machado, Oliveira and Fernandes (2009) at full severity: each kind of
 * dichromacy as one matrix on linear RGB, which is the space feColorMatrix
 * works in by default.
 */
const MATRICES: Record<Exclude<Vision, ''>, number[]> = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The three filters canvas.css names, made once, the first time one is asked for. */
function ensureFilters() {
  if (document.getElementById('mbrd-sim-filters')) return;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.id = 'mbrd-sim-filters';
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.classList.add('vh');
  for (const [kind, m] of Object.entries(MATRICES)) {
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.id = `mbrd-sim-${kind}`;
    const matrix = document.createElementNS(SVG_NS, 'feColorMatrix');
    matrix.setAttribute('type', 'matrix');
    matrix.setAttribute('values', [
      m[0], m[1], m[2], 0, 0,
      m[3], m[4], m[5], 0, 0,
      m[6], m[7], m[8], 0, 0,
      0, 0, 0, 1, 0,
    ].join(' '));
    filter.append(matrix);
    svg.append(filter);
  }
  document.body.append(svg);
}

function paint() {
  const root = document.documentElement;
  const mode = visionMode();
  const sim = visionSimulated();
  if (mode) root.dataset.cvd = mode;
  else delete root.dataset.cvd;
  if (sim) {
    ensureFilters();
    root.dataset.cvdSim = sim;
  } else {
    delete root.dataset.cvdSim;
  }
}

/** Put the stored choices on the page. Called once, from main.ts. */
export function initColourVision() {
  paint();
}
