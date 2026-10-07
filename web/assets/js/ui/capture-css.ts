// The text half of ui/capture.ts: the app's cascade cut into what a card
// capture carries, and the SVG a card is drawn through. Pure string work, no
// DOM and no imports, so tests/capture.test.js reads it with no browser.

/** One @font-face rule out of a sheet: its family and the files it loads. */
export type Face = { family: string, rule: string, urls: string[] };

const FACE_RULE = /@font-face\s*\{[^}]*\}/g;
const URL_IN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/** A family name as a computed `font-family` or a descriptor writes it, unquoted. */
export const plainFamily = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2').trim().toLowerCase();

/** The families a computed `font-family` value names, first choice first. */
export const familiesOf = (value: string) => value.split(',').map(plainFamily).filter(Boolean);

/**
 * A sheet, cut in two: its @font-face rules, and the rest. Every url() in
 * either is resolved against the sheet, so the same file has one address
 * wherever it is named; a fragment (an SVG filter) is emptied. An image
 * document loads nothing but data: URLs - inlineURLs() settles the rest per card.
 */
export function splitSheet(text: string, base: string): { faces: Face[], rest: string } {
  const faces: Face[] = [];
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rest = noComments.replace(FACE_RULE, rule => {
    const family = /font-family\s*:\s*([^;}]+)/.exec(rule)?.[1];
    if (family) {
      const urls: string[] = [];
      const resolved = rule.replace(URL_IN, (_, _q, u: string) => {
        if (u.startsWith('data:')) return `url("${u}")`;
        const abs = new URL(u, base).href;
        urls.push(abs);
        return `url("${abs}")`;
      });
      faces.push({ family: plainFamily(family), rule: resolved, urls });
    }
    return '';
  });
  return {
    faces,
    rest: rest.replace(URL_IN, (whole, _q, u: string) =>
      (u.startsWith('data:') ? whole : u.startsWith('#') ? 'none' : `url("${new URL(u, base).href}")`)),
  };
}

/**
 * The cascade for one card: the files `inline` holds made data: URLs, every
 * other address emptied - a url() left pointing at a file is a request that
 * fails inside the capture, and inlining every picture the sheets name would
 * carry them all into every card.
 */
export const inlineURLs = (css: string, inline: ReadonlyMap<string, string>) =>
  css.replace(URL_IN, (whole, _q, u: string) =>
    (u.startsWith('data:') ? whole : inline.has(u) ? `url("${inline.get(u)}")` : 'none'));

/** The files a computed `background-image` or `mask-image` value reads. */
export const urlsIn = (value: string) =>
  [...value.matchAll(URL_IN)].map(m => m[2]).filter(u => !u.startsWith('data:') && !u.startsWith('#'));

/** A face rule with its files swapped for the data: URLs `inline` holds. */
export function inlineFace(face: Face, inline: ReadonlyMap<string, string>): string | null {
  let out = face.rule;
  for (const u of face.urls) {
    const data = inline.get(u);
    if (!data) return null;
    out = out.split(`url("${u}")`).join(`url("${data}")`);
  }
  return out;
}

/**
 * The rules a capture adds after the cascade. The card is drawn at the origin,
 * upright and still - the export turns it and draws its shadow itself - and
 * the ground and the page around it are not part of it.
 */
export const CAPTURE_CSS = `
body{margin:0;padding:0;background:none !important;overflow:visible}
#viewport,#world{position:absolute !important;left:0 !important;top:0 !important;inset:0;transform:none !important;
background:none !important;overflow:visible !important;contain:none !important}
#world>.item{left:0 !important;top:0 !important;transform:none !important;translate:none !important;
rotate:none !important;scale:none !important;box-shadow:none !important;visibility:visible !important}
#world .item,#world .item *{transition:none !important;animation:none !important}
`;

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * The SVG one card is drawn through: the root wears the document's own
 * attributes so `:root[data-whimsy]` rules match it and its custom properties
 * inherit down; the card sits in a body, a #viewport and a #world so the
 * sheets' own selectors reach it. `css` goes in as CDATA; a sheet holding the
 * one sequence that would end it is refused rather than mangled.
 */
export function cardSvg(
  { w, h, rootAttrs, bodyClass, css, card }:
  { w: number, h: number, rootAttrs: [string, string][], bodyClass: string, css: string, card: string },
): string {
  if (css.includes(']]>')) throw new Error('a stylesheet holds "]]>"');
  const attrs = rootAttrs.map(([k, v]) => ` ${k}="${attr(v)}"`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${attrs}>`
    + `<style><![CDATA[${css}]]></style>`
    + `<foreignObject x="0" y="0" width="${w}" height="${h}">`
    + `<body xmlns="http://www.w3.org/1999/xhtml" class="${attr(bodyClass)}">`
    + `<div id="viewport"><div id="world">${card}</div></div></body>`
    + '</foreignObject></svg>';
}

/** A string as a data: URL an <img> decodes as SVG. */
export const svgURL = (svg: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
