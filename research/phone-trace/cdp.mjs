// Throwaway: a dependency-free CDP client for profiling the Android WebView
// over `adb forward`. Node has no WebSocket client in 22, so this does the
// handshake and frame coding by hand. Usage:
//   node cdp.mjs eval "<js>"        -> Runtime.evaluate, prints the result
//   node cdp.mjs frames <seconds>   -> requestAnimationFrame deltas, summarised
// Delete with the rest of research/phone-trace when the lag work is done.

import net from 'node:net';
import crypto from 'node:crypto';

const PORT = 9222;

async function pageSocket() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json());
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');
  return page.webSocketDebuggerUrl.replace(`ws://127.0.0.1:${PORT}`, '');
}

function connect(path) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      sock.off('data', onData);
      const rest = buf.subarray(end + 4);
      resolve({ sock, rest });
    };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

function frame(payload) {
  const data = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(data.map((b, i) => b ^ mask[i % 4]));
  let head;
  if (data.length < 126) head = Buffer.from([0x81, 0x80 | data.length]);
  else if (data.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x81; head[1] = 0xfe; head.writeUInt16BE(data.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x81; head[1] = 0xff; head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([head, mask, masked]);
}

/** Pull whole text frames out of a growing buffer. Server frames are unmasked. */
function* readFrames(state) {
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return;
    const len0 = b[1] & 0x7f;
    let off = 2, len = len0;
    if (len0 === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len0 === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (b.length < off + len) return;
    const payload = b.subarray(off, off + len).toString();
    state.buf = b.subarray(off + len);
    if ((b[0] & 0x0f) === 1) yield payload;
  }
}

async function session() {
  const { sock, rest } = await connect(await pageSocket());
  const state = { buf: rest };
  const waiting = new Map();
  let id = 0;
  const events = [];
  sock.on('data', d => {
    state.buf = Buffer.concat([state.buf, d]);
    for (const text of readFrames(state)) {
      const msg = JSON.parse(text);
      if (msg.id === undefined) { events.push(msg); continue; }
      const fn = waiting.get(msg.id);
      if (fn) { waiting.delete(msg.id); fn(msg); }
    }
  });
  const send = (method, params = {}) => new Promise(res => {
    const n = ++id;
    waiting.set(n, res);
    sock.write(frame(JSON.stringify({ id: n, method, params })));
  });
  return { send, events, close: () => sock.destroy() };
}

const evaluate = (s, expression, awaitPromise = true) =>
  s.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    .then(r => r.result?.result?.value ?? r.result?.exceptionDetails ?? r.result);

const [cmd, arg] = process.argv.slice(2);
const s = await session();
if (cmd === 'eval') {
  console.log(JSON.stringify(await evaluate(s, arg), null, 2));
} else if (cmd === 'zoomloop') {
  // The zoom driven from inside the page: one viewTo per frame, no USB round
  // trip in the loop. Same per-frame work as a pinch (zoom changes, --iz, grain
  // resample, cull, re-raster) with none of the harness's latency in the
  // numbers. RUNS=n repeats it and reports each.
  const secs = Number(arg || 6);
  if (process.env.RULE === 'isviewing') await evaluate(s, `(() => {
    if (document.getElementById('ab')) return 'already';
    const st = document.createElement('style'); st.id = 'ab';
    st.textContent = '#world.is-viewing{will-change:transform}';
    document.head.append(st); return 'on';
  })()`);
  if (process.env.IZ === 'freeze') await evaluate(s, `(() => {
    if (window.__izPatched) return 'already';
    window.__izPatched = 1;
    const vp = mbrd.vp, setIz = vp._setIz.bind(vp);
    vp._setIz = function(v) { if (!vp.moving) setIz(v); };
    return 'on';
  })()`);
  if (process.env.GRAIN === 'off') await evaluate(s, "document.documentElement.dataset.qGrain = 'off'");
  // --iz on a coarser ladder while the board is moving, rather than frozen.
  if (process.env.IZ === 'coarse') await evaluate(s, `(() => {
    if (window.__izPatched) return 'already';
    window.__izPatched = 1;
    const vp = mbrd.vp, setIz = vp._setIz.bind(vp), STEP = ${Number(process.env.IZSTEP || 0.25)};
    vp._setIz = v => setIz(vp.moving ? Math.exp(Math.round(Math.log(v) / STEP) * STEP) : v);
    return 'on';
  })()`);
  // The still-frame capture reads pixels back off the GPU, which the trace puts
  // at ~110ms a go. Defer it out of the gesture.
  if (process.env.STILLS === 'defer') await evaluate(s, `(() => {
    if (window.__stillsPatched) return 'already';
    window.__stillsPatched = 1;
    const tb = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function(cb, ...r) {
      if (mbrd.vp.moving) return; return tb.call(this, cb, ...r);
    };
    if (globalThis.OffscreenCanvas) {
      const cb = OffscreenCanvas.prototype.convertToBlob;
      OffscreenCanvas.prototype.convertToBlob = function(...a) {
        if (mbrd.vp.moving) return new Promise(() => {}); return cb.apply(this, a);
      };
    }
    return 'on';
  })()`);
  // The other whole-document invalidation: --grain-fade is written on :root as
  // the zoom changes, and a root custom property re-styles the entire page.
  if (process.env.FADE === 'freeze') await evaluate(s, `(() => {
    if (window.__fadePatched) return 'already';
    window.__fadePatched = 1;
    const ds = document.documentElement.style, sp = ds.setProperty.bind(ds);
    ds.setProperty = (k, v, p) => { if (k === '--grain-fade' && mbrd.vp.moving) return; sp(k, v, p); };
    return 'on';
  })()`);
  const out = await evaluate(s, `new Promise(done => {
    const vp = mbrd.vp, base = 1, gaps = [];
    const t0 = performance.now(); let last = t0;
    (function tick(now) {
      gaps.push(now - last); last = now;
      const t = (now - t0) / 1000;
      // A pinch in and out, twice a second of travel either way.
      vp.viewTo(vp.pan, base * Math.exp(Math.sin(t * 1.6) * 0.8), 0);
      if (t < ${secs}) requestAnimationFrame(tick); else {
        const d = gaps.slice(2).sort((a, b) => a - b);
        const at = p => d[Math.min(d.length - 1, Math.floor(d.length * p))];
        const base5 = at(0.05) || 16.7;
        done({
          frames: d.length,
          median: +at(0.5).toFixed(1),
          p95: +at(0.95).toFixed(1),
          worst: +at(1).toFixed(1),
          overTwoBeats: +(100 * d.filter(x => x > base5 * 2.5).length / d.length).toFixed(1),
        });
      }
    })(t0);
  })`);
  console.log(JSON.stringify(out));
} else if (cmd === 'tracezoom') {
  // The in-page zoom loop with the whole renderer traced, so the frame budget
  // can be read by event name rather than guessed at.
  if (process.env.IZ === 'freeze') await evaluate(s, `(() => {
    const vp = mbrd.vp, setIz = vp._setIz.bind(vp);
    vp._setIz = function(v) { if (!vp.moving) setIz(v); };
    return 'iz frozen';
  })()`);
  await s.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { includedCategories: ['disabled-by-default-devtools.timeline', 'blink', 'cc', 'gpu'] },
  });
  await evaluate(s, `new Promise(done => {
    const vp = mbrd.vp; const t0 = performance.now();
    (function tick(now) {
      const t = (now - t0) / 1000;
      vp.viewTo(vp.pan, Math.exp(Math.sin(t * 1.6) * 0.8), 0);
      if (t < ${Number(arg || 6)}) requestAnimationFrame(tick); else done(1);
    })(t0);
  })`);
  await s.send('Tracing.end');
  for (let i = 0; i < 90 && !s.events.some(e => e.method === 'Tracing.tracingComplete'); i++)
    await new Promise(r => setTimeout(r, 500));
  const all = s.events.filter(e => e.method === 'Tracing.dataCollected').flatMap(e => e.params.value);
  const byName = new Map();
  for (const e of all) {
    if (!e.dur) continue;
    const k = e.name;
    const v = byName.get(k) || { ms: 0, n: 0 };
    v.ms += e.dur / 1000; v.n++;
    byName.set(k, v);
  }
  console.log(`${all.length} events`);
  for (const [k, v] of [...byName].sort((a, b) => b[1].ms - a[1].ms).slice(0, 18))
    console.log(`${v.ms.toFixed(0).padStart(7)}ms  ${String(v.n).padStart(6)}x  ${(v.ms / v.n).toFixed(1).padStart(6)}ms avg  ${k}`);
} else if (cmd === 'trace') {
  // A pinch with the renderer's timeline recorded, so the style recalcs can be
  // read off with the invalidation that scheduled them.
  const mid = await evaluate(s, '({x: Math.round(innerWidth/2), y: Math.round(innerHeight*0.45)})');
  await s.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { includedCategories: [
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.invalidationTracking',
    ] },
  });
  const two = (type, gap) => s.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [
      { x: mid.x - gap, y: mid.y - gap, id: 1 },
      { x: mid.x + gap, y: mid.y + gap, id: 2 },
    ],
  });
  for (let lap = 0; lap < Number(arg || 2); lap++) {
    const out = lap % 2 === 0;
    await two('touchStart', out ? 40 : 200);
    for (let i = 1; i <= 20; i++) {
      await two('touchMove', out ? 40 + i * 8 : 200 - i * 8);
      await evaluate(s, 'new Promise(r => requestAnimationFrame(r))');
    }
    await two('touchEnd');
    await evaluate(s, 'new Promise(r => setTimeout(r, 500))');
  }
  console.log('zoom after pinch', await evaluate(s, '+mbrd.vp.zoom.toFixed(3)'));
  await s.send('Tracing.end');
  // Wait for the renderer to say it has handed everything over, not a guess.
  for (let i = 0; i < 60 && !s.events.some(e => e.method === 'Tracing.tracingComplete'); i++)
    await new Promise(r => setTimeout(r, 500));
  const all = s.events.filter(e => e.method === 'Tracing.dataCollected').flatMap(e => e.params.value);
  const recalcs = all.filter(e => e.name === 'UpdateLayoutTree' && e.dur);
  const total = recalcs.reduce((n, e) => n + e.dur, 0) / 1000;
  const elems = recalcs.reduce((n, e) => n + (e.args?.elementCount || 0), 0);
  console.log(`${all.length} trace events`);
  console.log(`UpdateLayoutTree: ${recalcs.length} recalcs, ${total.toFixed(0)}ms total, ${elems} elements touched`);
  const worst = recalcs.sort((a, b) => b.dur - a.dur).slice(0, 5);
  for (const w of worst) console.log(`  ${(w.dur / 1000).toFixed(1)}ms  ${w.args?.elementCount ?? '?'} elements`);
  const reasons = new Map();
  for (const e of all) {
    if (!/InvalidationTracking/.test(e.name)) continue;
    const d = e.args?.data || {};
    const key = `${e.name.replace('Tracking', '')} ${d.reason || d.invalidationSet || ''} ${d.nodeName || ''} ${d.extraData || ''}`.trim();
    reasons.set(key, (reasons.get(key) || 0) + 1);
  }
  for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`${String(n).padStart(6)}  ${k}`);
} else if (cmd === 'pinch') {
  // Two fingers in and out about the centre, which is the gesture the board is
  // reported worst at. Same measurements as panmetrics.
  const mid = await evaluate(s, '({x: Math.round(innerWidth/2), y: Math.round(innerHeight*0.45)})');
  await s.send('Performance.enable');
  if (process.env.ZOOM) {
    await evaluate(s, `mbrd.vp.viewTo(mbrd.vp.pan, ${Number(process.env.ZOOM)}, 0), "zoomed"`);
    await evaluate(s, 'new Promise(r => setTimeout(r, 600))');
  }
  // Knobs for the pinch A/B. RULE=isviewing pins the raster scale for the
  // length of the gesture only; IZ=freeze stops the per-frame --iz write, which
  // is what re-styles the whole board as the zoom changes.
  if (process.env.RULE === 'isviewing') await evaluate(s, `(() => {
    if (document.getElementById('ab')) return 'already';
    const st = document.createElement('style'); st.id = 'ab';
    st.textContent = '#world.is-viewing{will-change:transform}';
    document.head.append(st); return 'rule on';
  })()`);
  if (process.env.IZ === 'freeze') await evaluate(s, `(() => {
    if (window.__izPatched) return 'already';
    window.__izPatched = 1;
    const vp = mbrd.vp, setIz = vp._setIz.bind(vp);
    vp._setIz = function(v) { if (!vp.moving) setIz(v); };
    return 'iz frozen while moving';
  })()`);
  await evaluate(s, 'mbrd.perf.on(false), "armed"');
  const grabP = async () => Object.fromEntries(
    (await s.send('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]));
  const beforeP = await grabP();
  const two = (type, gap) => s.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [
      { x: mid.x - gap, y: mid.y - gap, id: 1 },
      { x: mid.x + gap, y: mid.y + gap, id: 2 },
    ],
  });
  for (let lap = 0; lap < Number(arg || 3); lap++) {
    const out = lap % 2 === 0;
    await two('touchStart', out ? 40 : 200);
    for (let i = 1; i <= 20; i++) {
      await two('touchMove', out ? 40 + i * 8 : 200 - i * 8);
      await evaluate(s, 'new Promise(r => requestAnimationFrame(r))');
    }
    await two('touchEnd');
    await evaluate(s, 'new Promise(r => setTimeout(r, 700))');
  }
  const afterP = await grabP();
  const wallP = afterP.Timestamp - beforeP.Timestamp;
  console.log(`over ${(wallP * 1000).toFixed(0)}ms:`, ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration']
    .map(k => `${k.replace('Duration', '')} ${((afterP[k] - beforeP[k]) * 1000).toFixed(0)}ms`).join('  '),
    ` styleRecalcs ${afterP.RecalcStyleCount - beforeP.RecalcStyleCount}`);
  console.log('zoom now', await evaluate(s, '+mbrd.vp.zoom.toFixed(3)'));
  console.log(await evaluate(s, 'JSON.stringify(mbrd.perf.report() ?? null, null, 1)'));
  await evaluate(s, 'mbrd.perf.off(), "off"');
} else if (cmd === 'panmetrics') {
  // The same pan, measured by the renderer's own counters: how much of the
  // gesture went to style, layout and script rather than to JS this app wrote.
  const seat = await evaluate(s, `(() => {
    const w = innerWidth, h = innerHeight;
    for (let y = h * 0.65; y > h * 0.2; y -= 12) for (let x = w * 0.5; x < w - 20; x += 12) {
      const el = document.elementFromPoint(x, y);
      if (el && !el.closest('.item') && el.closest('#viewport')) return { x: Math.round(x), y: Math.round(y) };
    }
    return null;
  })()`);
  await s.send('Performance.enable');
  // Env knobs for the A/B: ZOOM sets the zoom before the gesture, WILLCHANGE=1
  // puts the old `will-change: transform` back on the board layer at runtime.
  if (process.env.ZOOM) {
    await evaluate(s, `mbrd.vp.viewTo(mbrd.vp.pan, ${Number(process.env.ZOOM)}, 0), "zoomed"`);
    await evaluate(s, 'new Promise(r => setTimeout(r, 600))');
  }
  await evaluate(s, `document.getElementById('world').style.willChange =
    ${process.env.WILLCHANGE === '1' ? "'transform'" : "''"}`);
  console.log(`zoom ${await evaluate(s, '+mbrd.vp.zoom.toFixed(3)')}  will-change: ${
    await evaluate(s, "document.getElementById('world').style.willChange || '(none)'")}`);
  await evaluate(s, 'mbrd.perf.on(false), "armed"');
  const grab = async () => Object.fromEntries(
    (await s.send('Performance.getMetrics')).result.metrics.map(m => [m.name, m.value]));
  const before = await grab();
  const touch = (type, x, y) => s.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const motionPin = process.env.WILLCHANGE === 'motion';
  const pin = v => evaluate(s, `document.getElementById('world').style.willChange = ${v ? "'transform'" : "''"}`);
  for (let lap = 0; lap < Number(arg || 3); lap++) {
    const dir = lap % 2 ? 1 : -1;
    if (motionPin) await pin(true);
    await touch('touchStart', seat.x, seat.y);
    // A fling, not a crawl: ~40px a frame is what a thrown board gets, and the
    // release is what hands it to glide().
    const step = Number(process.env.PAN_STEP || 40);
    for (let i = 1; i <= 20; i++) {
      await touch('touchMove', seat.x + dir * i * step * 0.8, seat.y + dir * i * step * 0.4);
      await evaluate(s, 'new Promise(r => requestAnimationFrame(r))');
    }
    await touch('touchEnd', seat.x, seat.y);
    await evaluate(s, 'new Promise(r => setTimeout(r, 900))');
    if (motionPin) await pin(false);
  }
  const after = await grab();
  console.log('mbrd.perf:', await evaluate(s, 'JSON.stringify(mbrd.perf.report() ?? null, null, 1)'));
  await evaluate(s, 'mbrd.perf.off(), "off"');
  const wall = after.Timestamp - before.Timestamp;
  console.log(`over ${(wall * 1000).toFixed(0)}ms of gesture:`);
  for (const k of ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration',
                   'LayoutCount', 'RecalcStyleCount', 'Nodes', 'LayoutObjects', 'JSHeapUsedSize']) {
    const d = (after[k] ?? 0) - (before[k] ?? 0);
    const shown = k.endsWith('Duration') ? `${(d * 1000).toFixed(0)}ms (${(100 * d / wall).toFixed(1)}% of wall)`
      : k === 'JSHeapUsedSize' ? `${(after[k] / 1e6).toFixed(1)}MB (${d > 0 ? '+' : ''}${(d / 1e6).toFixed(1)})`
      : `${d} (now ${after[k]})`;
    console.log(`  ${k.padEnd(20)} ${shown}`);
  }
} else if (cmd === 'panprofile') {
  // A pan driven as real touch input, with the main thread profiled across it
  // and every rAF delta recorded. The start point is chosen by the page itself:
  // a spot where the top element is the board and not a card, so this pans and
  // never drags somebody's picture across their board.
  const seat = await evaluate(s, `(() => {
    const w = innerWidth, h = innerHeight;
    for (let y = h * 0.65; y > h * 0.2; y -= 12) for (let x = w * 0.5; x < w - 20; x += 12) {
      const el = document.elementFromPoint(x, y);
      if (el && !el.closest('.item') && (el.id === 'viewport' || el.id === 'world' || el.closest('#viewport')))
        return { x: Math.round(x), y: Math.round(y), on: el.id || el.className };
    }
    return null;
  })()`);
  if (!seat) { console.log('no empty spot to start a pan from'); s.close(); process.exit(0); }
  console.log(`panning from (${seat.x}, ${seat.y}) on ${seat.on}`);
  await evaluate(s, `window.__t = []; window.__last = performance.now();
    (function tick(now) { window.__t.push(now - window.__last); window.__last = now;
      window.__raf = requestAnimationFrame(tick); })(performance.now())`);
  await s.send('Profiler.enable');
  await s.send('Profiler.setSamplingInterval', { interval: 200 });
  await s.send('Profiler.start');
  const touch = (type, x, y) => s.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  const laps = Number(arg || 3);
  for (let lap = 0; lap < laps; lap++) {
    const dir = lap % 2 ? 1 : -1;
    await touch('touchStart', seat.x, seat.y);
    for (let i = 1; i <= 24; i++) {
      await touch('touchMove', seat.x + dir * i * 9, seat.y + dir * i * 5);
      await evaluate(s, 'new Promise(r => requestAnimationFrame(r))');
    }
    await touch('touchEnd', seat.x, seat.y);
    await evaluate(s, 'new Promise(r => setTimeout(r, 300))');
  }
  const { result } = await s.send('Profiler.stop');
  const t = await evaluate(s, 'cancelAnimationFrame(window.__raf); window.__t');
  const d = t.slice(2).sort((a, b) => a - b);
  const at = p => d[Math.min(d.length - 1, Math.floor(d.length * p))]?.toFixed(1);
  console.log(`frames ${d.length}  median ${at(0.5)}ms  p90 ${at(0.9)}ms  p99 ${at(0.99)}ms  worst ${at(1)}ms`);
  console.log(`over 32ms: ${d.filter(x => x > 32).length}  over 100ms: ${d.filter(x => x > 100).length}`);
  const p = result.profile;
  const byId = new Map(p.nodes.map(n => [n.id, n]));
  const self = new Map();
  for (const id of p.samples) {
    const f = byId.get(id)?.callFrame;
    if (!f) continue;
    const where = `${f.functionName || '(anonymous)'} @ ${(f.url || '').split('/').pop()}:${f.lineNumber + 1}`;
    self.set(where, (self.get(where) || 0) + 1);
  }
  const ms = (p.endTime - p.startTime) / 1000;
  console.log(`\n${p.samples.length} samples over ${ms.toFixed(0)}ms`);
  for (const [where, n] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`${(100 * n / p.samples.length).toFixed(1).padStart(5)}%  ${(n * ms / p.samples.length).toFixed(0).padStart(5)}ms  ${where}`);
  }
} else if (cmd === 'profile') {
  const secs = Number(arg || 5);
  await s.send('Profiler.enable');
  await s.send('Profiler.setSamplingInterval', { interval: 200 });
  await s.send('Profiler.start');
  await evaluate(s, `new Promise(r => setTimeout(r, ${secs * 1000}))`);
  const { result } = await s.send('Profiler.stop');
  const p = result.profile;
  const self = new Map();
  const byId = new Map(p.nodes.map(n => [n.id, n]));
  for (let i = 0; i < p.samples.length; i++) {
    const n = byId.get(p.samples[i]);
    if (!n) continue;
    const f = n.callFrame;
    const where = `${f.functionName || '(anonymous)'} @ ${(f.url || '').split('/').pop()}:${f.lineNumber + 1}`;
    self.set(where, (self.get(where) || 0) + 1);
  }
  const total = p.samples.length;
  const ms = (p.endTime - p.startTime) / 1000;
  console.log(`${total} samples over ${ms.toFixed(0)}ms`);
  for (const [where, n] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`${(100 * n / total).toFixed(1).padStart(5)}%  ${(n * ms / total).toFixed(0).padStart(5)}ms  ${where}`);
  }
} else if (cmd === 'frames') {
  const secs = Number(arg || 5);
  const out = await evaluate(s, `new Promise(done => {
    const t = []; let last = performance.now();
    const stop = performance.now() + ${secs * 1000};
    (function tick(now) {
      t.push(now - last); last = now;
      if (now < stop) requestAnimationFrame(tick); else done(t);
    })(last);
  })`);
  const d = out.slice(1).sort((a, b) => a - b);
  const at = p => d[Math.min(d.length - 1, Math.floor(d.length * p))]?.toFixed(1);
  console.log(`frames ${d.length}  median ${at(0.5)}ms  p90 ${at(0.9)}ms  p99 ${at(0.99)}ms  worst ${at(1)}ms`);
  console.log(`over 32ms: ${d.filter(x => x > 32).length}  over 100ms: ${d.filter(x => x > 100).length}`);
}
s.close();
