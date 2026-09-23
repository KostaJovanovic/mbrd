// Render the two install-prompt screenshots manifest.json names:
// web/assets/img/screenshot-wide.png (1280x800, the canvas) and
// screenshot-narrow.png (720x1280, the Feed on a phone). Real app, real board:
// this packs a demo .mbrd, drops it on a fresh headless Edge pointed at the dev
// server, and shoots each layout. Every picture on the board is drawn below, so
// nothing needs licensing. Needs the dev server up and desktop/node_modules.
//
//   node tools/gen-screenshots.mjs [http://127.0.0.1:6273/]

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const IMG = join(HERE, '..', 'web', 'assets', 'img');
const URL_ = process.argv[2] || 'http://127.0.0.1:6273/';
const PORT = 9337;

const require = createRequire(join(HERE, '..', 'desktop', 'package.json'));
const sharp = require('sharp');

const BROWSERS = [
  process.env.EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);
const browser = BROWSERS.find(p => existsSync(p));
if (!browser) throw new Error('No Edge or Chrome found; set EDGE to its path.');

// --- The pictures ----------------------------------------------------------
// Flat landscapes in the og card's manner: gradients and silhouettes.

const scene = (w, h, sky, sun, layers) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">${sky.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>
<radialGradient id="g"><stop offset="0" stop-color="${sun?.[3] || '#fff'}" stop-opacity=".55"/><stop offset="1" stop-color="${sun?.[3] || '#fff'}" stop-opacity="0"/></radialGradient></defs>
<rect width="${w}" height="${h}" fill="url(#s)"/>
${sun ? `<circle cx="${sun[0]}" cy="${sun[1]}" r="${sun[2] * 3}" fill="url(#g)"/><circle cx="${sun[0]}" cy="${sun[1]}" r="${sun[2]}" fill="${sun[3]}"/>` : ''}
${layers.map(([d, c]) => `<path d="${d}" fill="${c}"/>`).join('\n')}
</svg>`;

const PICTURES = {
  'dusk-hills.jpg': scene(900, 600,
    [[0, '#3b3a63'], [0.45, '#c8687a'], [0.75, '#f2a65e'], [1, '#f7d08a']], [620, 360, 46, '#ffe3a8'], [
      ['M0 400 C 150 340, 300 380, 450 350 S 750 330, 900 380 V600 H0Z', '#6a4a6b'],
      ['M0 470 C 200 420, 380 470, 560 440 S 800 430, 900 460 V600 H0Z', '#4a3452'],
      ['M0 540 C 220 500, 460 540, 700 515 S 860 520, 900 530 V600 H0Z', '#2e2238'],
    ]),
  'sea.jpg': scene(800, 800,
    [[0, '#9cc4d6'], [0.55, '#e8dccb'], [0.56, '#5f8fa6'], [1, '#2f5b72']], [240, 330, 34, '#fff4dc'], [
      ['M0 470 Q 200 460, 400 472 T 800 468 V480 H0Z', '#7eaabd'],
      ['M0 560 Q 200 548, 400 562 T 800 556 V570 H0Z', '#4f7f96'],
      ['M0 680 Q 200 664, 400 682 T 800 674 V690 H0Z', '#3d6c84'],
    ]),
  'pines.jpg': scene(600, 800,
    [[0, '#dfe6d6'], [0.6, '#b8c7a8'], [1, '#8fa27c']], null, [
      ...[[40, 520, 90], [150, 470, 120], [260, 540, 80], [360, 450, 140], [480, 510, 100], [570, 480, 110]]
        .map(([x, y, s]) => [`M${x} ${y - s * 2.4} L${x + s * 0.55} ${y} L${x - s * 0.55} ${y}Z`, '#5d7552']),
      ...[[90, 640, 130], [230, 610, 150], [400, 650, 120], [540, 620, 140]]
        .map(([x, y, s]) => [`M${x} ${y - s * 2.4} L${x + s * 0.6} ${y} L${x - s * 0.6} ${y}Z`, '#3c5237']),
      ['M0 700 C 150 680, 400 700, 600 690 V800 H0Z', '#2d3d2a'],
    ]),
  'dunes.jpg': scene(900, 600,
    [[0, '#f4d9b8'], [0.5, '#f7e6cf'], [1, '#f7e6cf']], [700, 150, 40, '#fff8ec'], [
      ['M0 330 C 200 260, 360 300, 520 330 S 800 300, 900 320 V600 H0Z', '#e2b27e'],
      ['M0 420 C 260 350, 460 420, 640 400 S 840 380, 900 400 V600 H0Z', '#cf8f5a'],
      ['M0 520 C 180 470, 400 530, 620 500 S 820 490, 900 510 V600 H0Z', '#b06f43'],
    ]),
  'lake.jpg': scene(800, 600,
    [[0, '#cfd8e6'], [0.5, '#e9e2ea'], [0.51, '#9fb0c6'], [1, '#6f84a0']], null, [
      ['M0 300 L 150 170 L 250 250 L 380 110 L 520 240 L 620 180 L 800 300Z', '#7c8aa5'],
      ['M300 175 L 380 110 L 450 175 L 420 165 L 380 150 L 340 170Z', '#f3f1f4'],
      ['M0 300 L 800 300 V 312 H0Z', '#56657f'],
      ['M0 306 L 150 400 L 250 346 L 380 460 L 520 352 L 620 392 L 800 306Z', '#8d9bb4'],
    ]),
};

// --- The sound ---------------------------------------------------------------
// Four seconds of rain: filtered noise under a slow swell, 16 kHz mono.

function rain() {
  const rate = 16000, n = rate * 4;
  const pcm = new Int16Array(n);
  let seed = 7, lo = 0;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    lo += ((seed / 0x7fffffff) * 2 - 1 - lo) * 0.3;
    const t = i / n;
    const swell = 0.35 + 0.45 * Math.sin(Math.PI * t) + 0.2 * Math.sin(t * 29) * Math.sin(t * 7);
    pcm[i] = Math.round(lo * swell * 26000);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + n * 2, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(n * 2, 40);
  const res = 240, per = Math.floor(n / res), peaks = [];
  for (let k = 0; k < res; k++) {
    let sum = 0;
    for (let i = k * per; i < (k + 1) * per; i++) sum += (pcm[i] / 32768) ** 2;
    peaks.push(Math.round(Math.min(1, Math.sqrt(sum / per) * 3) * 1000) / 1000);
  }
  return { bytes: Buffer.concat([head, Buffer.from(pcm.buffer)]), peaks };
}

// --- The board -------------------------------------------------------------

const sha = b => createHash('sha256').update(b).digest('hex');
const entries = [];
const assets = {};
const addAsset = (name, bytes) => {
  const hash = sha(bytes);
  assets[name] = { hash, bytes };
  entries.push([`assets/${hash}.${name.split('.').pop()}`, bytes]);
  return hash;
};

for (const [name, svg] of Object.entries(PICTURES)) {
  addAsset(name, await sharp(Buffer.from(svg)).jpeg({ quality: 84, mozjpeg: true }).toBuffer());
}
const sound = rain();
addAsset('rain-on-the-roof.wav', sound.bytes);
entries.push([`waveforms/${assets['rain-on-the-roof.wav'].hash}.json`,
  Buffer.from(JSON.stringify({ res: sound.peaks.length, peaks: sound.peaks }))]);

let z = 0;
const item = (id, type, x, y, w, h, name, extra = {}) =>
  ({ id, type, x, y, w, h, rot: 0, z: ++z, name, asset: null, meta: {}, ...extra });
const picture = (id, file, x, y, w, h) => {
  const a = assets[file];
  return item(id, 'image', x, y, w, h, file, {
    asset: { hash: a.hash, embedded: true },
    meta: { mime: 'image/jpeg', ext: 'jpg', size: a.bytes.length, origName: file, sized: true },
  });
};
const note = (id, x, y, w, h, text, tint) => item(id, 'note', x, y, w, h, text.split('\n')[0].replace(/^#+ /, ''), { meta: { text, tint } });
const swatch = (id, x, y, hex) => item(id, 'swatch', x, y, 128, 160, hex.toUpperCase(), { meta: { hex } });

const items = [
  // Placed rather than left to seed, which would put it over the sea.
  item('__title__', 'title', -720, 250, 300, 120, 'Cabin weekend'),
  item('fence1', 'fence', 470, -250, 620, 270, 'Palette', { meta: { tint: 2 } }),
  picture('p1', 'dusk-hills.jpg', -330, 150, 480, 320),
  picture('p2', 'sea.jpg', 150, 180, 300, 300),
  picture('p3', 'pines.jpg', -700, -60, 240, 320),
  picture('p4', 'dunes.jpg', 560, 150, 420, 280),
  picture('p5', 'lake.jpg', -340, -250, 360, 270),
  note('n1', -20, -120, 240, 200, '# Late October\nwood, wool and low light. Nothing brighter than the sunset.', 1),
  note('n2', 890, -40, 220, 180, '# Ask Mira\nwhere the blanket from the lake house came from', 3),
  swatch('s1', 300, -250, '#c8687a'),
  swatch('s2', 430, -250, '#f2a65e'),
  swatch('s3', 560, -250, '#4a3452'),
  swatch('s4', 690, -250, '#5f8fa6'),
  item('a1', 'audio', 60, -310, 320, 96, 'rain-on-the-roof.wav', {
    asset: { hash: assets['rain-on-the-roof.wav'].hash, embedded: true },
    meta: { mime: 'audio/wav', ext: 'wav', size: sound.bytes.length, origName: 'rain-on-the-roof.wav', sized: true, duration: 4 },
  }),
  item('k1', 'sticker', -120, 290, 96, 96, 'Star', { rot: 9, meta: { shape: 's-star' } }),
  item('k2', 'sticker', 770, 300, 88, 88, 'Heart', { rot: -7, meta: { shape: 's-heart' } }),
];
const geometry = items.map(({ id, x, y, w, h, rot, z }) => ({ id, x, y, w, h, rot, z }));
const boardJson = {
  title: 'Cabin weekend',
  view: { pan: { x: 0, y: 0 }, zoom: 0.62 },
  settings: { grid: true, axes: false, snap: false, hud: true, gridStyle: 'dots', gridStep: 64, spacing: 32 },
  items,
  layouts: { desktop: geometry },
  connections: [['n1', 'p2'], ['n2', 'p4']],
};
const now = new Date().toISOString();
const manifest = { format: 'mbrd', version: 1, app: 'mbrd screenshots', created: now, modified: now, title: 'Cabin weekend', requires: [] };

// --- A stored ZIP ------------------------------------------------------------

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = b => { let c = ~0; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const mbrd = zip([
  ['mimetype', Buffer.from('application/vnd.mbrd+zip')],
  ['manifest.json', Buffer.from(JSON.stringify(manifest))],
  ['board.json', Buffer.from(JSON.stringify(boardJson))],
  ...entries,
]);

// --- Drive the browser -------------------------------------------------------

const wait = ms => new Promise(r => setTimeout(r, ms));

async function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  return (method, params = {}) => new Promise((ok, fail) => {
    const n = ++id;
    pending.set(n, m => (m.error ? fail(new Error(`${method}: ${m.error.message}`)) : ok(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}

// One browser and one empty profile per shot. The layout a device boots in is
// remembered per profile, so a phone shot taken after the desktop one would
// open the canvas, not the Feed.
async function shoot({ w, h, scale, mobile, out }) {
  const work = await mkdtemp(join(tmpdir(), 'mbrd-shots-'));
  const edge = spawn(browser, [
    '--headless=new', '--no-first-run', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${join(work, 'profile')}`, 'about:blank',
  ], { stdio: 'ignore' });
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await wait(200);
      target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())
        .then(list => list.find(t => t.type === 'page')).catch(() => null);
    }
    if (!target) throw new Error('Edge did not open a debugging port.');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
    const send = await cdp(ws);
    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || expr);
      return r.result.value;
    };
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile });
    if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Page.navigate', { url: URL_ });
    for (let i = 0; i < 100 && !(await evaluate('!!(window.mbrd && window.mbrd.cmds)').catch(() => false)); i++) await wait(200);
    await wait(1500);
    // A lone .mbrd dropped on an empty board opens as that board.
    await evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(mbrd.toString('base64'))}), c => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'Cabin_weekend.mbrd', { type: 'application/vnd.mbrd+zip' }));
      dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: ${w / 2}, clientY: ${h / 2}, bubbles: true, cancelable: true }));
    })()`);
    await wait(4000);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const png = await sharp(Buffer.from(data, 'base64'))
      .png({ palette: true, colours: 256, dither: 1, effort: 10, compressionLevel: 9 })
      .toBuffer();
    await writeFile(join(IMG, out), png);
    console.log(`${out} (${Math.round(png.length / 1024)} KB)`);
    ws.close();
  } finally {
    edge.kill();
    await wait(500);
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

// The sizes manifest.json declares. The phone is 360x640 at 2x, as one is.
await shoot({ w: 1280, h: 800, scale: 1, mobile: false, out: 'screenshot-wide.png' });
await shoot({ w: 360, h: 640, scale: 2, mobile: true, out: 'screenshot-narrow.png' });
