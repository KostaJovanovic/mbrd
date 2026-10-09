// A PureRef .pur writer for tests, laid out the way FyorDev's writer lays one
// out (1.10: header, pictures, items, folder, table). Shared by
// tests/pureref.test.js and the browser suite's import spec.

/** A PNG the walker accepts: signature, IHDR, IEND. Nothing decodes it. */
export function png(w, h) {
  const out = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const chunk = (type, data) => {
    out.push(...u32(data.length), ...[...type].map(c => c.charCodeAt(0)), ...data, 0, 0, 0, 0);
  };
  chunk('IHDR', [...u32(w), ...u32(h), 8, 6, 0, 0, 0]);
  chunk('IEND', []);
  return out;
}
export const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
export const u64 = n => [0, 0, 0, 0, ...u32(n)];
const f64 = v => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return [...b]; };
const utf16 = s => [...s].flatMap(c => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255]);
export const qstr = s => [...u32(s.length * 2), ...utf16(s)];
const matrix = ([a, b, c, d]) => [...f64(a), ...f64(b), ...f64(0), ...f64(c), ...f64(d), ...f64(0)];

/** `pictures` are byte arrays; each image names one by index and places it. */
export function pur({ pictures, images, texts = [] }) {
  const out = Array.from({ length: 224 }, () => 0);
  out.splice(0, 12, ...u32(8), ...utf16('1.10'));
  const starts = [];
  for (const p of pictures) {
    starts.push([out.length, out.length + p.length]);
    out.push(...p);
  }
  // Every image item after the first on a picture is four bytes naming that first one.
  const firstOn = new Map();
  const dupes = [];
  for (const im of images) {
    if (firstOn.has(im.picture)) {
      dupes.push({ id: im.id, at: out.length });
      out.push(...u32(firstOn.get(im.picture)));
    } else {
      firstOn.set(im.picture, im.id);
    }
  }
  const item = (kind, body) => {
    const at = out.length;
    out.push(...u64(0), ...u32(kind), ...utf16(kind === 34 ? 'GraphicsImageItem' : 'GraphicsTextItem'), ...body);
    out.splice(at, 8, ...u64(out.length));
  };
  for (const im of images) {
    const [w, h] = [im.w, im.h];
    const crop = im.crop ?? [-w / 2, -h / 2, w / 2, h / 2];
    item(34, [
      ...qstr('C:/refs/' + im.name), ...qstr(im.name), ...f64(1),
      ...matrix(im.m), ...f64(im.x), ...f64(im.y), ...f64(1), ...u32(im.id), ...f64(im.z ?? 0),
      ...matrix([1, 0, 0, 1]), ...f64(-w / 2), ...f64(-h / 2), ...f64(1),
      ...u32(5),
      ...[[crop[0], crop[1]], [crop[2], crop[1]], [crop[2], crop[3]], [crop[0], crop[3]], [crop[0], crop[1]]]
        .flatMap(([x, y], i) => [...u32(i ? 1 : 0), ...f64(x), ...f64(y)]),
      ...f64(0), ...u32(1), 0, ...f64(-1).map(() => 255), ...u32(0),
    ]);
  }
  for (const t of texts) {
    item(32, [
      ...qstr(t.text), ...matrix([1, 0, 0, 1]), ...f64(t.x), ...f64(t.y), ...f64(1), ...u32(t.id), ...f64(9),
      1, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 1, 19, 136, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(0),
    ]);
  }
  const refs = out.length;
  out.push(...qstr('C:/refs'));
  for (const im of images) {
    const dupe = dupes.find(d => d.id === im.id);
    const [s, e] = dupe ? [dupe.at, dupe.at + 4] : starts[im.picture];
    out.push(...u32(im.id), ...u64(s), ...u64(e));
  }
  out.splice(16, 8, ...u64(refs));
  return new Uint8Array(out);
}
