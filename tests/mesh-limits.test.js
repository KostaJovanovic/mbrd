// Crafted files that used to freeze, crash or exhaust the tab, each fed to its
// reader. Every reader runs synchronously on the main thread, so a file that
// costs a minute here costs the user a frozen board for a minute.
//
// Each test asserts two things: the reader ends with the right kind of
// failure (MeshError for a file that does not mean anything, Oversize for one
// that is larger than a number somebody wrote down), and it ends fast. The
// inputs are scaled down from the ones that found the fault, to sizes that
// took seconds before and take milliseconds now; the time limits are loose
// enough for a slow CI runner and still far below the old cost.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { parseMesh, MeshError } from '../web/assets/js/mesh.ts';
import { CAPS, resetCaps } from '../web/assets/js/mesh/shared.ts';
import { readZip } from '../web/assets/js/mesh/zip.ts';
import { scanXML } from '../web/assets/js/mesh/xml.ts';
import { isOversize } from '../web/assets/js/consent.ts';
import { JS, read } from './helpers.js';

const enc = new TextEncoder();
const buf = s => enc.encode(s).buffer;
const asBuffer = u8 => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

/** Run a parse, and say what came out and how long it took. */
function timed(fn) {
  const start = performance.now();
  let value = null, error = null;
  try { value = fn(); } catch (err) { error = err; }
  return { value, error, took: performance.now() - start };
}

/** A parse that must end in a MeshError - not an Oversize, not a RangeError
 *  from a blown stack, not a TypeError - and inside `ms`. */
function refusedFast(fn, ms, label) {
  const { error, value, took } = timed(fn);
  assert.ok(took < ms, `${label}: took ${took | 0} ms`);
  assert.ok(error, `${label}: read as a model with ${value?.count} vertices`);
  assert.ok(error instanceof MeshError, `${label}: threw ${error?.constructor?.name}: ${error?.message}`);
  assert.ok(!isOversize(error), `${label}: corruption offered as something to lift`);
  return error;
}

/** A parse that must end either in a model or in a MeshError, inside `ms`.
 *  For the inputs whose point is the cost of reading them rather than what
 *  they draw. */
function endsFast(fn, ms, label) {
  const { error, took } = timed(fn);
  assert.ok(took < ms, `${label}: took ${took | 0} ms`);
  if (error) assert.ok(error instanceof MeshError, `${label}: threw ${error.constructor?.name}: ${error.message}`);
}

// ---------------------------------------------------------------------------
// STEP
// ---------------------------------------------------------------------------

/** A STEP writer. `put` returns the record number; `next()` is the number the
 *  next `put` will get, for a record that names itself. */
function stepFile(write) {
  const lines = [];
  let n = 0;
  const put = record => { lines.push(`#${++n}=${record};`); return n; };
  write(put, () => n + 1);
  return `ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

/** One triangular planar face, (0,0,0) (10,0,0) (0,10,0). Its first edge runs
 *  along whatever curve `first(put, p0, p1)` returns; the other two are lines. */
function stepTriangle(first) {
  return stepFile((put, next) => {
    const at = [[0, 0, 0], [10, 0, 0], [0, 10, 0]];
    const P = at.map(([x, y, z]) => put(`CARTESIAN_POINT('',(${x}.,${y}.,${z}.))`));
    const V = P.map(p => put(`VERTEX_POINT('',#${p})`));
    const line = (a, b) => {
      const d = [0, 1, 2].map(k => at[b][k] - at[a][k]);
      const len = Math.hypot(...d);
      const dir = put(`DIRECTION('',(${d.map(v => (v / len).toFixed(6)).join(',')}))`);
      const vec = put(`VECTOR('',#${dir},${len}.)`);
      return put(`LINE('',#${P[a]},#${vec})`);
    };
    const curves = [first(put, P[0], P[1], line, next), line(1, 2), line(2, 0)];
    const edges = curves.map((c, i) => put(`EDGE_CURVE('',#${V[i]},#${V[(i + 1) % 3]},#${c},.T.)`));
    const oriented = edges.map(e => put(`ORIENTED_EDGE('',*,*,#${e},.T.)`));
    const loop = put(`EDGE_LOOP('',(${oriented.map(o => `#${o}`).join(',')}))`);
    const bound = put(`FACE_OUTER_BOUND('',#${loop},.T.)`);
    const up = put(`DIRECTION('',(0.,0.,1.))`);
    const place = put(`AXIS2_PLACEMENT_3D('',#${P[0]},#${up},$)`);
    const plane = put(`PLANE('',#${place})`);
    put(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`);
  });
}

const bspline = degree => (put, a, b) =>
  put(`B_SPLINE_CURVE_WITH_KNOTS('',${degree},(#${a},#${b}),.UNSPECIFIED.,.F.,.F.,(2,2),(0.,1.),.UNSPECIFIED.)`);

test('a STEP B-spline of an honest degree still reads', () => {
  const m = parseMesh('step', buf(stepTriangle(bspline(1))), 'y');
  assert.ok(m.count >= 3, `a triangle: ${m.count}`);
});

test('a STEP B-spline curve of an impossible degree is corrupt, and says so at once (C3)', () => {
  // 606 bytes and degree 10^8 was a four-gigabyte heap and a dead tab.
  refusedFast(() => parseMesh('step', buf(stepTriangle(bspline(100_000_000)))), 1000, 'degree 1e8');
  refusedFast(() => parseMesh('step', buf(stepTriangle(bspline(6400)))), 1000, 'degree 6400');
});

test('a STEP B-spline surface of an impossible degree is corrupt too (C3)', () => {
  const text = stepFile(put => {
    const pts = [[0, 0], [10, 0], [0, 10], [10, 10]]
      .map(([x, y]) => put(`CARTESIAN_POINT('',(${x}.,${y}.,0.))`));
    const surface = put(`B_SPLINE_SURFACE_WITH_KNOTS('',100000000,1,((#${pts[0]},#${pts[1]}),(#${pts[2]},#${pts[3]})),`
      + `.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.)`);
    const loop = put(`POLY_LOOP('',(#${pts[0]},#${pts[1]},#${pts[3]}))`);
    const bound = put(`FACE_OUTER_BOUND('',#${loop},.T.)`);
    put(`ADVANCED_FACE('',(#${bound}),#${surface},.T.)`);
  });
  refusedFast(() => parseMesh('step', buf(text)), 1000, 'surface degree 1e8');
});

test('a STEP record of bare words costs its length once, not once per word (H19)', () => {
  // `#1=X(A A A ...)`: every word scanned to the closing parenthesis before
  // being read as a word. 80,000 of them was 42 seconds.
  const text = stepFile(put => { put(`X(${'A '.repeat(40_000)})`); });
  refusedFast(() => parseMesh('step', buf(text)), 1000, 'bare words');
});

test('STEP parentheses nested past any record end in a MeshError, not a blown stack (L25)', () => {
  const deep = 100_000;
  const text = stepFile(put => { put(`X(${'('.repeat(deep)}${')'.repeat(deep)})`); });
  refusedFast(() => parseMesh('step', buf(text)), 2000, 'nested parentheses');
});

test('a STEP curve that names itself is a dead end, not a stack overflow (L25)', () => {
  const text = stepTriangle((put, a, b, line, next) =>
    put(`TRIMMED_CURVE('',#${next()},(PARAMETER_VALUE(0.)),(PARAMETER_VALUE(1.)),.T.,.PARAMETER.)`));
  endsFast(() => parseMesh('step', buf(text)), 1000, 'self-trimmed curve');
});

test('a STEP composite built of composites is built once per curve, not once per path (H21)', () => {
  // Two segments a level, both the level below: the old reader evaluated
  // 2^depth leaves. 22 levels were 2.7 s; 26 would be over 40.
  const text = stepTriangle((put, a, b, line) => {
    let curve = line(0, 1);
    for (let level = 0; level < 26; level++) {
      const seg = put(`COMPOSITE_CURVE_SEGMENT(.CONTINUOUS.,.T.,#${curve})`);
      curve = put(`COMPOSITE_CURVE('',(#${seg},#${seg}),.F.)`);
    }
    return curve;
  });
  endsFast(() => parseMesh('step', buf(text)), 1500, 'composite fan-out');
});

test('a STEP composite chain deeper than any real curve is refused, not a stack overflow (L25)', () => {
  const text = stepTriangle((put, a, b, line) => {
    let curve = line(0, 1);
    for (let level = 0; level < 20_000; level++) {
      curve = put(`TRIMMED_CURVE('',#${curve},(PARAMETER_VALUE(0.)),(PARAMETER_VALUE(1.)),.T.,.PARAMETER.)`);
    }
    return curve;
  });
  refusedFast(() => parseMesh('step', buf(text)), 2000, 'deep trimmed chain');
});

/** A star-shaped POLY_LOOP of `n` points - every other corner reflex, which
 *  is the ear clipper's worst case - under `faces` faces, each through its
 *  own FACE_OUTER_BOUND. */
function starFaces(n, faces) {
  return stepFile(put => {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2, r = i % 2 ? 5 : 10;
      pts.push(put(`CARTESIAN_POINT('',(${(r * Math.cos(a)).toFixed(5)},${(r * Math.sin(a)).toFixed(5)},0.))`));
    }
    const loop = put(`POLY_LOOP('',(${pts.map(p => `#${p}`).join(',')}))`);
    for (let f = 0; f < faces; f++) {
      const bound = put(`FACE_OUTER_BOUND('',#${loop},.T.)`);
      put(`FACE_SURFACE('',(#${bound}),$,.T.)`);
    }
  });
}

test('a STEP face with a very long boundary triangulates in time (H29)', () => {
  // One POLY_LOOP of 16,000 points was 14 s of ear clipping.
  const { value, error, took } = timed(() => parseMesh('step', buf(starFaces(16_000, 1)), 'y'));
  assert.equal(error, null, error?.message);
  assert.ok(took < 2000, `took ${took | 0} ms`);
  assert.ok(value.count > 0);
});

test('STEP faces sharing one long loop are triangulated once (H29)', () => {
  // A hundred faces over one 2,000-point loop were 20 s.
  const { value, error, took } = timed(() => parseMesh('step', buf(starFaces(2000, 100)), 'y'));
  assert.equal(error, null, error?.message);
  assert.ok(took < 2000, `took ${took | 0} ms`);
  const one = parseMesh('step', buf(starFaces(2000, 1)), 'y');
  assert.equal(value.count, one.count * 100, 'every face drawn, not only the first');
});

// ---------------------------------------------------------------------------
// IGES
// ---------------------------------------------------------------------------

/** Card images, as in mesh-formats.test.js. Entity k gets pointer 2k + 1. */
function igesFile(entities) {
  const pad = (v, n = 8) => String(v).padStart(n);
  const start = 'a test file'.padEnd(72) + 'S' + pad(1, 7);
  const global = "1H,,1H;,4Htest,4Htest,,,32,38,6,308,15,4Htest,1.,2,2HMM,;".padEnd(72) + 'G' + pad(1, 7);
  const directory = [];
  const parameters = [];
  let deSeq = 1;
  let peSeq = 1;
  for (const e of entities) {
    const body = `${e.type},${e.params.join(',')};`;
    const cards = body.match(/.{1,64}/g) || [''];
    const first = peSeq;
    for (const card of cards) {
      parameters.push(card.padEnd(64) + ' ' + pad(deSeq, 7) + 'P' + pad(peSeq, 7));
      peSeq++;
    }
    directory.push(
      [pad(e.type), pad(first), pad(0), pad(0), pad(0), pad(0), pad(0), pad(0), pad(0)].join('') + 'D' + pad(deSeq, 7),
      [pad(e.type), pad(0), pad(0), pad(cards.length), pad(0), pad(0), pad(0), ''.padEnd(8), pad(0)].join('') + 'D' + pad(deSeq + 1, 7),
    );
    deSeq += 2;
  }
  const terminate = ('S' + pad(1, 7) + 'G' + pad(1, 7) + 'D' + pad(directory.length, 7)
    + 'P' + pad(parameters.length, 7)).padEnd(72) + 'T' + pad(1, 7);
  return [start, global, ...directory, ...parameters, terminate].join('\n') + '\n';
}

const pointerOf = k => 2 * k + 1;

/** A flat degree-one patch over (0,0)-(10,10), with degrees overridable. */
const patch = (m1 = 1, m2 = 1) => ({
  type: 128,
  params: [1, 1, m1, m2, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1,
    0, 0, 0, 10, 0, 0, 0, 10, 0, 10, 10, 0, 0, 1, 0, 1],
});

test('an IGES spline surface of an impossible degree is corrupt (C4)', () => {
  refusedFast(() => parseMesh('iges', buf(igesFile([patch(1e9, 1)]))), 1000, 'surface degree 1e9');
});

test('an IGES spline curve of an impossible degree is corrupt, not a loop to 2^40 (C4)', () => {
  const curve = { type: 126, params: [1, 2 ** 40, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 10, 0, 0, 0, 1] };
  const trimmed = { type: 144, params: [pointerOf(0), 1, 0, pointerOf(1)] };
  refusedFast(() => parseMesh('iges', buf(igesFile([patch(), curve, trimmed]))), 1000, 'curve degree 2^40');
});

test('an IGES spline curve that declares more than it carries is not read as zeros', () => {
  // A million control points out of a forty-byte record.
  const curve = { type: 126, params: [999_999, 3, 0, 0, 1, 0] };
  const trimmed = { type: 144, params: [pointerOf(0), 1, 0, pointerOf(1)] };
  endsFast(() => parseMesh('iges', buf(igesFile([patch(), curve, trimmed]))), 1000, 'short curve record');
});

test('an IGES composite built of composites is built once per curve (H21)', () => {
  const line = { type: 110, params: [0, 0, 0, 10, 0, 0] };
  const chain = [line];
  for (let level = 1; level <= 16; level++) {
    chain.push({ type: 102, params: [2, pointerOf(level - 1), pointerOf(level - 1)] });
  }
  const trimmed = { type: 144, params: [pointerOf(chain.length), 1, 0, pointerOf(chain.length - 1)] };
  endsFast(() => parseMesh('iges', buf(igesFile([...chain, patch(), trimmed]))), 1500, 'iges composite fan-out');
});

// ---------------------------------------------------------------------------
// PLY
// ---------------------------------------------------------------------------

test('a PLY element with no properties is refused rather than stepped over forever (H14)', () => {
  const head = f => `ply\nformat ${f} 1.0\nelement junk 9000000000000\n`
    + 'element vertex 3\nproperty float x\nproperty float y\nproperty float z\n'
    + 'element face 1\nproperty list uchar int vertex_indices\nend_header\n';
  refusedFast(() => parseMesh('ply', buf(`${head('ascii')}0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n`)), 500, 'ascii');
  refusedFast(() => parseMesh('ply', buf(head('binary_little_endian'))), 500, 'binary');
});

test('a PLY face naming vertex 1.5 is corrupt, not half a vertex (L21)', () => {
  const text = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n'
    + 'element face 1\nproperty list uchar float vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 1.5\n';
  refusedFast(() => parseMesh('ply', buf(text)), 500, 'fractional index');
});

// ---------------------------------------------------------------------------
// glTF
// ---------------------------------------------------------------------------

test('a glTF node shared down a chain reads its arrays once, not once per path (H15)', () => {
  // Node i has node i+1 as both of its children, so the leaf is reached
  // 2^depth times. Its index list is empty: nothing is drawn, so the
  // triangle ceiling never stops it, and every visit read the whole
  // position array again.
  const verts = 40_000;
  const bytes = new Uint8Array(verts * 12);
  const depth = 12;
  const nodes = [];
  for (let i = 0; i < depth; i++) nodes.push({ children: [i + 1, i + 1] });
  nodes.push({ mesh: 0 });
  const json = {
    buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: verts, type: 'VEC3' },
      { bufferView: 0, componentType: 5125, count: 0, type: 'SCALAR' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes,
    scenes: [{ nodes: [0] }],
  };
  refusedFast(() => parseMesh('glb', buf(JSON.stringify(json))), 1500, 'shared children');
});

test('glTF arrays that each pass their own ceiling are still held to one for the parse (H15)', () => {
  // Viewless accessors cost a file fifty bytes each and allocate what they
  // claim. Every one is under the per-array line; together they are not.
  const accessors = [];
  const primitives = [];
  for (let i = 0; i < 600; i++) {
    accessors.push({ componentType: 5126, count: 33_333, type: 'VEC3' });
    primitives.push({ attributes: { POSITION: i } });
  }
  const json = { accessors, meshes: [{ primitives }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }] };
  const saved = CAPS.elem;
  CAPS.elem = 100_000;           // eight of these is 800,000: past it by the 25th array
  try {
    const { error, took } = timed(() => parseMesh('glb', buf(JSON.stringify(json))));
    assert.ok(isOversize(error), `expected a question, got ${error?.constructor?.name}: ${error?.message}`);
    assert.ok(took < 1000, `took ${took | 0} ms`);
  } finally {
    CAPS.elem = saved;
    resetCaps();
  }
});

// ---------------------------------------------------------------------------
// FBX
// ---------------------------------------------------------------------------

/** Binary FBX records, laid out as in mesh-formats.test.js. */
const fbxNode = (name, props, kids = []) => ({ name, props, kids });

function fbxBytes(node, start) {
  const nameBytes = enc.encode(node.name);
  const propBytes = node.props.reduce((n, p) => n + p.length, 0);
  let at = start + 13 + nameBytes.length + propBytes;
  const kids = [];
  for (const kid of node.kids) {
    const bytes = fbxBytes(kid, at);
    kids.push(bytes);
    at += bytes.length;
  }
  const end = at + (node.kids.length ? 13 : 0);
  const out = new Uint8Array(end - start);
  const view = new DataView(out.buffer);
  view.setUint32(0, end, true);
  view.setUint32(4, node.props.length, true);
  view.setUint32(8, propBytes, true);
  out[12] = nameBytes.length;
  out.set(nameBytes, 13);
  let cursor = 13 + nameBytes.length;
  for (const p of node.props) { out.set(p, cursor); cursor += p.length; }
  for (const k of kids) { out.set(k, cursor); cursor += k.length; }
  return out;
}

const fbxLong = v => { const b = new Uint8Array(9); b[0] = 0x4c; new DataView(b.buffer).setBigInt64(1, BigInt(v), true); return b; };

function fbxArray(code, values) {
  const width = code === 'd' ? 8 : 4;
  const plain = new Uint8Array(values.length * width);
  const pv = new DataView(plain.buffer);
  values.forEach((v, i) => (code === 'd' ? pv.setFloat64(i * width, v, true) : pv.setInt32(i * width, v, true)));
  const payload = new Uint8Array(deflateSync(Buffer.from(plain)));
  const b = new Uint8Array(13 + payload.length);
  b[0] = code.charCodeAt(0);
  const bv = new DataView(b.buffer);
  bv.setUint32(1, values.length, true);
  bv.setUint32(5, 1, true);
  bv.setUint32(9, payload.length, true);
  b.set(payload, 13);
  return b;
}

function fbxHead() {
  const head = new Uint8Array(27);
  head.set(enc.encode('Kaydara FBX Binary  '), 0);
  head[21] = 0x1a;
  new DataView(head.buffer).setUint32(23, 7300, true);
  return head;
}

function fbxFile(roots) {
  const placed = [];
  let at = 27;
  for (const node of roots) {
    const bytes = fbxBytes(node, at);
    placed.push(bytes);
    at += bytes.length;
  }
  const out = new Uint8Array(at + 13);
  out.set(fbxHead(), 0);
  let cursor = 27;
  for (const bytes of placed) { out.set(bytes, cursor); cursor += bytes.length; }
  return asBuffer(out);
}

test('FBX arrays are held to one ceiling for the parse, not one each (H16)', () => {
  // A hundred geometries, each a zlib-packed array just under the per-array
  // line, ran the tab out of memory after two minutes. Scaled down here by
  // lowering the line: nine arrays of a thousand against a total of eight.
  const n = 1000;
  const geometry = id => fbxNode('Geometry', [fbxLong(id)], [
    fbxNode('Vertices', [fbxArray('d', new Array(n).fill(0))]),
    fbxNode('PolygonVertexIndex', [fbxArray('i', [0, 1, ~2])]),
  ]);
  const file = fbxFile(Array.from({ length: 9 }, (_, i) => geometry(100 + i)));
  CAPS.elem = n;
  try {
    const { error } = timed(() => parseMesh('fbx', file));
    assert.ok(isOversize(error), `expected a question, got ${error?.constructor?.name}: ${error?.message}`);
  } finally {
    resetCaps();
  }
  // And it is a question: lifted, the same file reads.
  CAPS.elem = n;
  assert.ok(parseMesh('fbx', file, 'y', true).count > 0);
});

test('an ascii FBX with openings and no closing brace is read in one pass (H18)', () => {
  // 40,000 of these was 29 s: each opening scanned to the end of the file.
  refusedFast(() => parseMesh('fbx', buf('Vertices: *1 { a: '.repeat(20_000))), 1000, 'unclosed arrays');
});

test('an ascii FBX still reads its arrays', () => {
  const text = 'Vertices: *9 {\n a: 0,0,0,1,0,0,0,1,0\n}\nPolygonVertexIndex: *3 {\n a: 0,1,-3\n}\n';
  assert.equal(parseMesh('fbx', buf(text), 'y').count, 3);
});

test('FBX records nested past any exporter end in a MeshError, not a blown stack (L25)', () => {
  // Each record: 13 header bytes, a one-byte name, one child, a null record.
  const depth = 50_000;
  const size = 27 + depth * 14 + (depth - 1) * 13 + 13;
  const out = new Uint8Array(size);
  out.set(fbxHead(), 0);
  const view = new DataView(out.buffer);
  const innerEnd = 27 + depth * 14;
  for (let k = 0; k < depth; k++) {
    const start = 27 + k * 14;
    const end = k === depth - 1 ? innerEnd : innerEnd + (depth - 1 - k) * 13;
    view.setUint32(start, end, true);
    out[start + 12] = 1;
    out[start + 13] = 0x41;
  }
  refusedFast(() => parseMesh('fbx', asBuffer(out)), 2000, 'deep records');
});

// ---------------------------------------------------------------------------
// XML: AMF, 3MF, Collada
// ---------------------------------------------------------------------------

test('an attribute name with no value costs its length once (H17)', () => {
  // 160,000 characters of one name froze the thread for 15.6 s.
  refusedFast(() => parseMesh('amf', buf(`<amf><a ${'x'.repeat(80_000)}/></amf>`)), 1000, 'long bare name');
});

test('attributes still read in every form the regex took', () => {
  const seen = [];
  scanXML(`<a b="1" c='2' d=3 e = "4" bare f="x>y" g=''/><h ns:i="5"/>`, {
    open(name, attrs) { seen.push([name, { ...attrs }]); },
  });
  assert.deepEqual(seen, [
    ['a', { b: '1', c: '2', d: '3', e: '4', f: 'x>y', g: '' }],
    ['h', { i: '5' }],
  ]);
});

test('an XML tree nested past any model ends in a MeshError, not a blown stack (L25)', () => {
  const deep = 100_000;
  const text = `<COLLADA>${'<node>'.repeat(deep)}${'</node>'.repeat(deep)}</COLLADA>`;
  refusedFast(() => parseMesh('dae', buf(text)), 2000, 'deep collada');
});

test('AMF constellations that fan out are held to a visit count, not only a depth (H20)', () => {
  // Two instances a level of the level below, down to an object with no
  // geometry. 24 levels were 1.6 s; 32, the depth limit, about seven minutes.
  const levels = 30;
  let text = '<amf><object id="leaf"><mesh><vertices></vertices></mesh></object>';
  for (let k = 0; k < levels; k++) {
    const below = k + 1 < levels ? `c${k + 1}` : 'leaf';
    text += `<constellation id="c${k}"><instance objectid="${below}"/><instance objectid="${below}"/></constellation>`;
  }
  text += '</amf>';
  refusedFast(() => parseMesh('amf', buf(text)), 3000, 'constellation fan-out');
});

test('an AMF triangle naming vertex 1.5 is corrupt (L22)', () => {
  const text = '<amf><object id="0"><mesh><vertices>'
    + '<vertex><coordinates><x>0</x><y>0</y><z>0</z></coordinates></vertex>'
    + '<vertex><coordinates><x>1</x><y>0</y><z>0</z></coordinates></vertex>'
    + '<vertex><coordinates><x>0</x><y>1</y><z>0</z></coordinates></vertex>'
    + '</vertices><volume><triangle><v1>0</v1><v2>1</v2><v3>1.5</v3></triangle></volume></mesh></object></amf>';
  refusedFast(() => parseMesh('amf', buf(text)), 500, 'fractional index');
});

test('a Collada array instanced many times is parsed once (H30)', () => {
  // 2,000 instances of one 500,000-number array were 39 s: each instance
  // parsed the text again, and with no triangles nothing else stopped it.
  const numbers = new Array(200_000).fill('1.5').join(' ');
  const instances = '<instance_geometry url="#g"/>'.repeat(400);
  const text = `<COLLADA><library_geometries><geometry id="g"><mesh>
    <source id="s"><float_array id="a" count="200000">${numbers}</float_array></source>
    <vertices id="v"><input semantic="POSITION" source="#s"/></vertices>
    <triangles count="0"><input semantic="VERTEX" source="#v" offset="0"/></triangles>
    </mesh></geometry></library_geometries>
    <library_visual_scenes><visual_scene id="scene"><node>${instances}</node></visual_scene></library_visual_scenes>
    </COLLADA>`;
  refusedFast(() => parseMesh('dae', buf(text)), 2000, 'repeated instances');
});

// ---------------------------------------------------------------------------
// ZIP (3MF, AMF)
// ---------------------------------------------------------------------------

/** Two deflated entries, and the directory's local offsets for them. */
function twoEntryZip(a, b, { sameLocal = false } = {}) {
  const local = [], central = [];
  let offset = 0;
  const offsets = [];
  for (const [name, plain] of [a, b]) {
    const nb = enc.encode(name);
    const packed = new Uint8Array(deflateRawSync(Buffer.from(plain)));
    const head = new Uint8Array(30 + nb.length);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 0x04034b50, true);
    hv.setUint16(8, 8, true);
    hv.setUint32(18, packed.length, true);
    hv.setUint32(22, plain.length, true);
    hv.setUint16(26, nb.length, true);
    head.set(nb, 30);
    local.push(head, packed);
    offsets.push(offset);

    const dir = new Uint8Array(46 + nb.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(10, 8, true);
    dv.setUint32(20, packed.length, true);
    dv.setUint32(24, plain.length, true);
    dv.setUint16(28, nb.length, true);
    dv.setUint32(42, sameLocal ? 0 : offset, true);
    dir.set(nb, 46);
    central.push(dir);
    offset += head.length + packed.length;
  }
  const dirBytes = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 2, true);
  ev.setUint16(10, 2, true);
  ev.setUint32(12, dirBytes, true);
  ev.setUint32(16, offset, true);
  const all = [...local, ...central, end];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}

test('two names over one entry of a model archive are corruption (M27)', () => {
  const plain = new Uint8Array(100);
  assert.throws(() => readZip(twoEntryZip(['a', plain], ['b', plain], { sameLocal: true })), MeshError);
  assert.equal(readZip(twoEntryZip(['a', plain], ['b', plain])).size, 2, 'the control archive reads');
});

test('the inflate ceiling is for the whole archive, not each entry (M27)', () => {
  const plain = new Uint8Array(2000);
  CAPS.buf = 3000;
  try {
    const zip = readZip(twoEntryZip(['a', plain], ['b', plain]));
    assert.equal(zip.get('a').read().length, 2000, 'the first entry fits');
    assert.throws(() => zip.get('b').read(), err => isOversize(err), 'the second is past the total');
  } finally {
    resetCaps();
  }
});

// ---------------------------------------------------------------------------
// Bounds, 3DS
// ---------------------------------------------------------------------------

test('a vertex at infinity on any axis is refused rather than drawn blank (M37)', () => {
  // Binary STL: one facet, its third corner at x = +Infinity. min x is finite,
  // which is all the old check looked at.
  const stl = new Uint8Array(84 + 50);
  const v = new DataView(stl.buffer);
  v.setUint32(80, 1, true);
  const corners = [[0, 0, 0], [1, 0, 0], [Infinity, 1, 0]];
  corners.forEach((c, i) => c.forEach((n, k) => v.setFloat32(84 + 12 + i * 12 + k * 4, n, true)));
  refusedFast(() => parseMesh('stl', asBuffer(stl)), 500, 'infinite x');

  // A number past float range is infinity once stored, whichever reader.
  refusedFast(() => parseMesh('obj', buf('v 0 0 0\nv 1 0 0\nv 0 1e39 0\nf 1 2 3\n')), 500, 'obj 1e39');
});

test('a 3DS object nested in another is read, not a TypeError (L24)', () => {
  const chunk = (id, ...parts) => {
    const body = parts.flatMap(p => (typeof p === 'string' ? [...enc.encode(p), 0] : p));
    const out = new Uint8Array(6 + body.length);
    const view = new DataView(out.buffer);
    view.setUint16(0, id, true);
    view.setUint32(2, out.length, true);
    out.set(body, 6);
    return [...out];
  };
  const u16 = n => [n & 0xff, (n >> 8) & 0xff];
  const f32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, n, true); return [...b]; };
  const verts = [[0, 0, 0], [2, 0, 0], [0, 3, 0]];
  const mesh = chunk(0x4100,
    chunk(0x4110, u16(3), verts.flatMap(p => p.flatMap(f32))),
    chunk(0x4120, u16(1), [...u16(0), ...u16(1), ...u16(2), ...u16(0)]));
  const inner = chunk(0x4000, 'inner', mesh);
  const outer = chunk(0x4000, 'outer', inner);
  const file = asBuffer(new Uint8Array(chunk(0x4d4d, chunk(0x3d3d, outer))));
  const { value, error } = timed(() => parseMesh('3ds', file, 'y'));
  assert.equal(error, null, `${error?.constructor?.name}: ${error?.message}`);
  assert.equal(value.count, 3);
});

// ---------------------------------------------------------------------------
// The CAD kernel's worker, and the main-thread side of it
// ---------------------------------------------------------------------------

test('a kernel that throws is made again for the next file, not kept broken (L23)', async () => {
  const SOURCE = read(join(JS, 'mesh', 'occt-worker.js'));
  const replies = [];
  let made = 0;
  const context = createContext({
    URL, Math, Float32Array, Uint8Array, Error, console,
    importScripts() {},
    postMessage(data) { replies.push(data); },
    location: { href: 'https://mbrd.test/assets/js/mesh/occt-worker.js' },
  });
  context.self = context;
  context.occtimportjs = () => {
    const broken = made++ === 0;
    return Promise.resolve({
      ReadStepFile: () => { if (broken) throw new Error('Aborted()'); return { success: true, meshes: [] }; },
    });
  };
  runInContext(SOURCE, context, { filename: 'occt-worker.js' });
  await context.onmessage({ data: { id: 1, kind: 'step', bytes: new ArrayBuffer(8), maxTriangles: 10 } });
  await context.onmessage({ data: { id: 2, kind: 'step', bytes: new ArrayBuffer(8), maxTriangles: 10 } });
  assert.match(replies[0].error, /Aborted/);
  assert.equal(made, 2, 'the aborted instance was used again');
});

test('a kernel call that never returns is ended, and the queue moves on (M28, L23)', async () => {
  const workers = [];
  class FakeWorker {
    constructor() { this.sent = []; this.terminated = false; workers.push(this); }
    postMessage(data) { this.sent.push(data); }
    terminate() { this.terminated = true; }
  }
  const had = { Worker: globalThis.Worker, document: globalThis.document };
  globalThis.Worker = FakeWorker;
  globalThis.document = { baseURI: 'https://mbrd.test/' };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { kernelMesh, KERNEL_TIMEOUT } = await import('../web/assets/js/mesh/occt.ts');
    const settle = () => new Promise(resolve => setImmediate(resolve));

    const hung = kernelMesh('step', new ArrayBuffer(8), 10);
    await settle();
    assert.equal(workers.length, 1);
    assert.equal(workers[0].sent.length, 1, 'the file never reached the kernel');
    mock.timers.tick(KERNEL_TIMEOUT);
    assert.equal(await hung, null, 'a timed-out file falls back to the reader here');
    assert.ok(workers[0].terminated, 'the hung worker was left running');

    // The next file is not queued behind the hung one: a fresh worker has it.
    const after = kernelMesh('step', new ArrayBuffer(8), 10);
    await settle();
    assert.equal(workers.length, 2);
    const { id } = workers[1].sent[0];
    workers[1].onmessage({ data: { id, error: 'no geometry' } });
    assert.equal(await after, null);

    // An error event ends the worker too, and releases what was waiting.
    const errored = kernelMesh('step', new ArrayBuffer(8), 10);
    await settle();
    workers[1].onerror();
    assert.equal(await errored, null);
    assert.ok(workers[1].terminated, 'an errored worker was left running');
  } finally {
    mock.timers.reset();
    globalThis.Worker = had.Worker;
    globalThis.document = had.document;
  }
});
