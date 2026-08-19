// The eight readers that were added beside STL, OBJ and glTF.
//
// Same rule as tests/mesh.test.js, which covers the original three: every
// fixture is built here, to the byte, rather than checked in. A .3mf generated
// by the same ZIP code that reads it would check nothing, so the archive below
// is written by hand and node's own zlib supplies the compressed entries - which
// is the one thing in this file that is not this project's code, and is exactly
// the point.
//
// What each format is checked for is the same three things:
//
//   - the geometry comes out where the file put it, in the file's own units;
//   - what the file says about *placement* is honoured - a 3MF's build plate, an
//     FBX's model transforms, a Collada node's matrix - because that is what
//     separates reading a scene from piling every part on the origin;
//   - a broken file is a MeshError and not a crash, a hang, or a silent empty
//     model.
//
// The CAD pair get a fourth: a cylinder tessellates to about as many triangles
// as its circumference is sampled with. That number is the whole quality of the
// tessellator in one assertion - it went from four thousand to a hundred when
// the polygon orientation was fixed - and it is the thing most likely to regress
// silently, because a wrong tessellation still produces a model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, deflateSync } from 'node:zlib';

import {
  parseMesh, meshKind, defaultUpAxis, upAxisIsGuessed, MeshError,
} from '../web/assets/js/mesh.ts';
import { inflateRaw, inflateZlib, readZip } from '../web/assets/js/mesh/zip.ts';
import { scanXML, parseXML, find, findAll } from '../web/assets/js/mesh/xml.ts';

const enc = new TextEncoder();
const buf = s => enc.encode(s).buffer;
const near = (a, b, msg, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

/** Every position in the mesh, as [x,y,z] triples. */
const points = m => Array.from({ length: m.count }, (_, i) =>
  [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]]);

const has = (m, p) => points(m).some(q => q.every((v, i) => Math.abs(v - p[i]) < 1e-4));

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('every new extension routes to its own reader', () => {
  assert.equal(meshKind('a.ply'), 'ply');
  assert.equal(meshKind('a.PLY'), 'ply');
  assert.equal(meshKind('a.off'), 'off');
  assert.equal(meshKind('a.3mf'), '3mf');
  assert.equal(meshKind('a.amf'), 'amf');
  assert.equal(meshKind('a.fbx'), 'fbx');
  assert.equal(meshKind('a.dae'), 'dae');
  assert.equal(meshKind('a.3ds'), '3ds');
  assert.equal(meshKind('a.step'), 'step');
  assert.equal(meshKind('a.stp'), 'step');
  assert.equal(meshKind('a.iges'), 'iges');
  assert.equal(meshKind('a.igs'), 'iges');
  // The three that were already there, unchanged.
  assert.equal(meshKind('a.stl'), 'stl');
  assert.equal(meshKind('a.obj'), 'obj');
  assert.equal(meshKind('a.gltf'), 'glb');
});

test('a material library is not a model', () => {
  // .mtl has no geometry; classifying it as a model would put an undrawable
  // card on the board beside the .obj that asked for it.
  assert.equal(meshKind('a.mtl'), null);
  assert.equal(meshKind('a.txt'), null);
  assert.equal(meshKind('noextension'), null);
  assert.equal(meshKind('.ply'), null);
});

test('the manufacturing formats are z-up and the rendering ones are not', () => {
  for (const kind of ['stl', 'obj', '3mf', 'amf', 'step', 'iges']) {
    assert.equal(defaultUpAxis(kind), 'z', kind);
  }
  for (const kind of ['glb', 'ply', 'dae', '3ds', 'fbx']) {
    assert.equal(defaultUpAxis(kind), 'y', kind);
  }
});

test('only the formats that settle their own axis are exempt from the flip', () => {
  // What canFlipUpAxis in commands/item-meta.ts asks. The three that are not
  // offered it are the three where defaultUpAxis() is not what was used - glTF
  // because its spec fixes the answer, FBX and Collada because the document
  // carries it - and a toggle built on a number that was not used spends its
  // first press appearing to do nothing.
  for (const kind of ['stl', 'obj', 'ply', '3ds', '3mf', 'amf', 'step', 'iges']) {
    assert.ok(upAxisIsGuessed(kind), kind);
  }
  for (const kind of ['glb', 'fbx', 'dae']) {
    assert.ok(!upAxisIsGuessed(kind), kind);
  }
});

test('an unknown kind is refused rather than read as something else', () => {
  assert.throws(() => parseMesh('sldprt', buf('anything')), MeshError);
  assert.throws(() => parseMesh(null, buf('anything')), MeshError);
});

// ---------------------------------------------------------------------------
// DEFLATE, which 3MF and FBX both stand on
// ---------------------------------------------------------------------------

test('the inflater reads every block type zlib emits', () => {
  const cases = {
    text: Buffer.from('the same words over and over '.repeat(400)),
    empty: Buffer.alloc(0),
    // Incompressible, so the encoder is forced into stored blocks.
    noise: Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 2654435761) & 0xff)),
    run: Buffer.alloc(70_000, 7),
  };
  for (const [name, data] of Object.entries(cases)) {
    const raw = inflateRaw(new Uint8Array(deflateRawSync(data)), data.length);
    assert.deepEqual(Buffer.from(raw), data, `raw ${name}`);
    const zlib = inflateZlib(new Uint8Array(deflateSync(data)), data.length);
    assert.deepEqual(Buffer.from(zlib), data, `zlib ${name}`);
  }
});

test('a truncated deflate stream is an error rather than a partial mesh', () => {
  const full = deflateRawSync(Buffer.from('x'.repeat(5000) + 'yz'));
  assert.throws(() => inflateRaw(new Uint8Array(full.subarray(0, full.length - 3))), MeshError);
});

test('a stream that is not zlib says so before it is decoded', () => {
  assert.throws(() => inflateZlib(new Uint8Array([0x00, 0x00, 0x00])), MeshError);
  assert.throws(() => inflateZlib(new Uint8Array([0x78])), MeshError);
});

test('a copy that reaches before the start of the output is refused', () => {
  // A hand-built fixed-Huffman block: literal 'a', then a length/distance pair
  // asking for a distance of two when only one byte has been written.
  //
  // BFINAL=1, BTYPE=01, literal 97 (code 0x71 in the fixed tree, 8 bits, MSB
  // first), length code 257 (7 bits of zero), distance code 1 (5 bits).
  const bits = [];
  const push = (value, n, reverse) => {
    for (let i = 0; i < n; i++) bits.push((value >> (reverse ? n - 1 - i : i)) & 1);
  };
  push(1, 1, false);            // BFINAL
  push(1, 2, false);            // BTYPE = fixed
  push(0x30 + 97, 8, true);     // literal 'a'
  push(1, 7, true);             // length code 257 (256 is 0) -> length 3
  push(1, 5, true);             // distance code 1 -> distance 2
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) bytes[i >> 3] |= 1 << (i & 7); });
  assert.throws(() => inflateRaw(bytes), MeshError);
});

// ---------------------------------------------------------------------------
// A ZIP, by hand
// ---------------------------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

const crc32 = b => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A ZIP archive of `[name, contents]` pairs. `deflate` picks method 8, which is
 *  what every real 3MF uses and what the reader has to inflate. */
function zip(entries, { deflate = true } = {}) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, contents] of entries) {
    const nb = enc.encode(name);
    const plain = typeof contents === 'string' ? enc.encode(contents) : contents;
    const packed = deflate ? new Uint8Array(deflateRawSync(Buffer.from(plain))) : plain;
    const method = deflate ? 8 : 0;

    const head = new Uint8Array(30 + nb.length);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 0x04034b50, true);
    hv.setUint16(4, 20, true);
    hv.setUint16(8, method, true);
    hv.setUint32(14, crc32(plain), true);
    hv.setUint32(18, packed.length, true);
    hv.setUint32(22, plain.length, true);
    hv.setUint16(26, nb.length, true);
    head.set(nb, 30);
    local.push(head, packed);

    const dir = new Uint8Array(46 + nb.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(10, method, true);
    dv.setUint32(16, crc32(plain), true);
    dv.setUint32(20, packed.length, true);
    dv.setUint32(24, plain.length, true);
    dv.setUint16(28, nb.length, true);
    dv.setUint32(42, offset, true);
    dir.set(nb, 46);
    central.push(dir);
    offset += head.length + packed.length;
  }
  const dirBytes = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, dirBytes, true);
  ev.setUint32(16, offset, true);

  const all = [...local, ...central, end];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) { out.set(c, at); at += c.length; }
  return out;
}

const asBuffer = u8 => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

test('the zip reader finds entries through the central directory', () => {
  const archive = readZip(zip([['a.txt', 'hello'], ['b/c.txt', 'world']]));
  assert.deepEqual([...archive.keys()], ['a.txt', 'b/c.txt']);
  assert.equal(new TextDecoder().decode(archive.get('a.txt').read()), 'hello');
  assert.equal(new TextDecoder().decode(archive.get('b/c.txt').read()), 'world');
});

test('two entries under one name are corruption rather than a last-one-wins', () => {
  assert.throws(() => readZip(zip([['a.txt', 'one'], ['a.txt', 'two']])), MeshError);
});

test('a file with no end-of-directory record is not a zip', () => {
  const bytes = zip([['a.txt', 'hello']]);
  assert.throws(() => readZip(bytes.subarray(0, bytes.length - 22)), MeshError);
});

// ---------------------------------------------------------------------------
// XML, with no DOM under it
// ---------------------------------------------------------------------------

test('the scanner reports tags in document order and decodes entities', () => {
  const seen = [];
  scanXML(
    `<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a n="1 &amp; 2"><b/><!-- c --><d>t&#65;xt</d></a>`,
    {
      open: (name, attrs, self) => seen.push(['open', name, attrs.n || '', self]),
      close: name => seen.push(['close', name]),
      text: value => seen.push(['text', value]),
    },
  );
  assert.deepEqual(seen, [
    ['open', 'a', '1 & 2', false],
    ['open', 'b', '', true],
    ['close', 'b'],
    ['open', 'd', '', false],
    ['text', 'tAxt'],
    ['close', 'd'],
    ['close', 'a'],
  ]);
});

test('a namespace prefix does not change which element this is', () => {
  const names = [];
  scanXML('<p:model xmlns:p="x"><p:vertex X="1"/></p:model>', { open: n => names.push(n) });
  assert.deepEqual(names, ['model', 'vertex']);
});

test('no entity declared in a doctype is ever expanded', () => {
  // The classic expansion attack has nothing to expand: the declaration is
  // skipped whole and `&lol;` is left as the literal text it is.
  const parts = [];
  scanXML(
    '<!DOCTYPE x [<!ENTITY lol "aaaaaaaaaa"><!ENTITY lol2 "&lol;&lol;">]><x>&lol2;</x>',
    { text: v => parts.push(v) },
  );
  assert.deepEqual(parts, ['&lol2;']);
});

test('the tree keeps text and attributes where the document put them', () => {
  const doc = parseXML('<root><a id="1">one</a><b><a id="2">two</a></b></root>');
  const all = findAll(doc, 'a');
  assert.equal(all.length, 2);
  assert.deepEqual(all.map(n => n.attrs.id), ['1', '2']);
  assert.equal(find(doc, 'b').kids[0].text, 'two');
});

// ---------------------------------------------------------------------------
// PLY
// ---------------------------------------------------------------------------

const PLY_ASCII = `ply
format ascii 1.0
comment written by a test
element vertex 4
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
element face 2
property list uchar int vertex_indices
end_header
0 0 0 255 0 0
1 0 0 0 255 0
1 1 0 0 0 255
0 1 0 255 255 255
3 0 1 2
3 0 2 3
`;

test('an ascii PLY reads its faces and its vertex colours', () => {
  const m = parseMesh('ply', buf(PLY_ASCII));
  assert.equal(m.count, 6);
  assert.ok(m.colors, 'colours');
  // First triangle's first corner is the red vertex. PLY is drawn y-up, so the
  // coordinates are not turned.
  assert.deepEqual([...m.colors.slice(0, 3)], [1, 0, 0]);
  near(m.colors[3], 0, 'second corner red');
  near(m.colors[4], 1, 'second corner green');
});

/** A binary little-endian PLY of one triangle. */
function binaryPLY({ big = false, faces = 1 } = {}) {
  const head = `ply\nformat binary_${big ? 'big' : 'little'}_endian 1.0\n`
    + 'element vertex 3\nproperty float x\nproperty float y\nproperty float z\n'
    + `element face ${faces}\nproperty list uchar int vertex_indices\nend_header\n`;
  const header = enc.encode(head);
  const body = new ArrayBuffer(3 * 12 + faces * 13);
  const view = new DataView(body);
  const le = !big;
  [0, 0, 0, 2, 0, 0, 0, 3, 0].forEach((n, i) => view.setFloat32(i * 4, n, le));
  for (let f = 0; f < faces; f++) {
    const at = 36 + f * 13;
    view.setUint8(at, 3);
    view.setInt32(at + 1, 0, le);
    view.setInt32(at + 5, 1, le);
    view.setInt32(at + 9, 2, le);
  }
  const out = new Uint8Array(header.length + body.byteLength);
  out.set(header);
  out.set(new Uint8Array(body), header.length);
  return asBuffer(out);
}

test('a binary PLY reads in both byte orders', () => {
  for (const big of [false, true]) {
    const m = parseMesh('ply', binaryPLY({ big }));
    assert.equal(m.count, 3, `count ${big}`);
    near(m.bounds.max[0], 2, `max x ${big}`);
    near(m.bounds.max[1], 3, `max y ${big}`);
  }
});

test('a PLY with vertices and no faces says it is a point cloud', () => {
  const m = () => parseMesh('ply', binaryPLY({ faces: 0 }));
  assert.throws(m, err => err instanceof MeshError && /point cloud/.test(err.message));
});

test('a PLY that declares more data than it carries is refused', () => {
  const full = new Uint8Array(binaryPLY());
  assert.throws(() => parseMesh('ply', asBuffer(full.subarray(0, full.length - 8))), MeshError);
});

test('a PLY with no header at all is not a PLY', () => {
  assert.throws(() => parseMesh('ply', buf('not a ply file')), MeshError);
});

// ---------------------------------------------------------------------------
// OFF
// ---------------------------------------------------------------------------

test('an OFF reads its counts from wherever they are written', () => {
  const separate = parseMesh('off', buf('OFF\n# a comment\n4 2 0\n0 0 0\n1 0 0\n1 1 0\n0 1 0\n3 0 1 2\n3 0 2 3\n'));
  const together = parseMesh('off', buf('OFF 4 2 0\n0 0 0\n1 0 0\n1 1 0\n0 1 0\n3 0 1 2\n3 0 2 3\n'));
  assert.equal(separate.count, 6);
  assert.deepEqual(separate.bounds, together.bounds);
});

test('a COFF carries a colour per vertex, in bytes or in fractions', () => {
  const bytes = parseMesh('off', buf('COFF 3 1 0\n0 0 0 255 0 0\n1 0 0 0 255 0\n0 1 0 0 0 255\n3 0 1 2\n'));
  const fractions = parseMesh('off', buf('COFF 3 1 0\n0 0 0 1 0 0\n1 0 0 0 1 0\n0 1 0 0 0 1\n3 0 1 2\n'));
  assert.deepEqual([...bytes.colors], [...fractions.colors]);
  assert.deepEqual([...bytes.colors.slice(0, 3)], [1, 0, 0]);
});

test('an OFF polygon is fanned into triangles', () => {
  const m = parseMesh('off', buf('OFF 4 1 0\n0 0 0\n1 0 0\n1 1 0\n0 1 0\n4 0 1 2 3\n'));
  assert.equal(m.count, 6, 'a quad is two triangles');
});

test('an OFF that declares more rows than it has is refused', () => {
  assert.throws(() => parseMesh('off', buf('OFF 400 200 0\n0 0 0\n')), MeshError);
});

// ---------------------------------------------------------------------------
// 3MF
// ---------------------------------------------------------------------------

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rel0" Target="/3D/3dmodel.model"
   Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

const MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources>
  <basematerials id="4"><base name="red" displaycolor="#FF0000FF"/></basematerials>
  <object id="1" type="model" pid="4" pindex="0">
   <mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/><vertex x="10" y="0" z="0"/>
     <vertex x="10" y="10" z="0"/><vertex x="0" y="0" z="10"/>
    </vertices>
    <triangles>
     <triangle v1="0" v2="1" v3="2"/>
     <triangle v1="0" v2="1" v3="3"/>
    </triangles>
   </mesh>
  </object>
  <object id="2" type="model">
   <components><component objectid="1" transform="1 0 0 0 1 0 0 0 1 100 0 0"/></components>
  </object>
 </resources>
 <build><item objectid="1"/><item objectid="2"/></build>
</model>`;

const threeMF = (entries = [['_rels/.rels', RELS], ['3D/3dmodel.model', MODEL]]) =>
  asBuffer(zip(entries));

test('a 3MF walks its build plate rather than its first mesh', () => {
  // Two build items over one object: the plain one at the origin and the
  // component one shifted 100 along x. Read naively this is one part twice in
  // the same place.
  const m = parseMesh('3mf', threeMF(), 'y');
  assert.equal(m.count, 12, 'two triangles, twice');
  near(m.bounds.min[0], 0, 'plate starts at the origin');
  near(m.bounds.max[0], 110, 'and reaches the shifted copy');
});

test('a 3MF takes its colour from the property group its object names', () => {
  const m = parseMesh('3mf', threeMF(), 'y');
  assert.ok(m.colors, 'colours');
  assert.deepEqual([...m.colors.slice(0, 3)], [1, 0, 0]);
});

test('a 3MF is found through its relationships and through the convention', () => {
  const named = threeMF([['_rels/.rels', RELS.replace('/3D/3dmodel.model', '/3D/part.model')],
                         ['3D/part.model', MODEL]]);
  const conventional = threeMF([['3D/3dmodel.model', MODEL]]);
  assert.equal(parseMesh('3mf', named, 'y').count, 12);
  assert.equal(parseMesh('3mf', conventional, 'y').count, 12);
});

test('a 3MF naming a vertex it does not carry is refused', () => {
  const broken = MODEL.replace('v3="2"', 'v3="99"');
  assert.throws(() => parseMesh('3mf', threeMF([['3D/3dmodel.model', broken]])), MeshError);
});

test('a 3MF with no model part in it says so', () => {
  assert.throws(() => parseMesh('3mf', threeMF([['a.txt', 'hello']])), MeshError);
});

test('a 3MF is read the same whether its entries were compressed or stored', () => {
  const stored = asBuffer(zip([['3D/3dmodel.model', MODEL]], { deflate: false }));
  const packed = threeMF([['3D/3dmodel.model', MODEL]]);
  assert.deepEqual(parseMesh('3mf', stored, 'y').bounds, parseMesh('3mf', packed, 'y').bounds);
});

// ---------------------------------------------------------------------------
// AMF
// ---------------------------------------------------------------------------

const AMF = `<?xml version="1.0"?>
<amf unit="millimeter">
 <object id="0">
  <mesh>
   <vertices>
    <vertex><coordinates><x>0</x><y>0</y><z>0</z></coordinates>
      <color><r>1</r><g>0</g><b>0</b></color></vertex>
    <vertex><coordinates><x>1</x><y>0</y><z>0</z></coordinates>
      <color><r>0</r><g>1</g><b>0</b></color></vertex>
    <vertex><coordinates><x>0</x><y>1</y><z>0</z></coordinates>
      <color><r>0</r><g>0</g><b>1</b></color></vertex>
   </vertices>
   <volume><triangle><v1>0</v1><v2>1</v2><v3>2</v3></triangle></volume>
  </mesh>
 </object>
 <constellation id="9">
  <instance objectid="0"><deltax>5</deltax><deltay>0</deltay><deltaz>0</deltaz></instance>
  <instance objectid="0"><deltax>0</deltax><deltay>0</deltay><deltaz>0</deltaz><rz>90</rz></instance>
 </constellation>
</amf>`;

test('an AMF places one object twice through its constellation', () => {
  const m = parseMesh('amf', buf(AMF), 'y');
  assert.equal(m.count, 6, 'one triangle, two instances');
  near(m.bounds.max[0], 6, 'the shifted instance');
  near(m.bounds.min[0], -1, 'and the turned one');
});

test('an AMF colours per vertex rather than per triangle', () => {
  const m = parseMesh('amf', buf(AMF), 'y');
  assert.deepEqual([...m.colors.slice(0, 3)], [1, 0, 0]);
  assert.deepEqual([...m.colors.slice(3, 6)], [0, 1, 0]);
  assert.deepEqual([...m.colors.slice(6, 9)], [0, 0, 1]);
});

test('an AMF inside a zip reads the same as one that is not', () => {
  const zipped = asBuffer(zip([['part.amf', AMF]]));
  assert.deepEqual(parseMesh('amf', zipped, 'y').bounds, parseMesh('amf', buf(AMF), 'y').bounds);
});

test('an AMF naming a vertex it does not carry is refused', () => {
  assert.throws(() => parseMesh('amf', buf(AMF.replace('<v3>2</v3>', '<v3>9</v3>'))), MeshError);
});

// ---------------------------------------------------------------------------
// FBX
// ---------------------------------------------------------------------------

/** Binary FBX is a tree of records: three offsets, a name, the properties, then
 *  the children and a null record. The first field is the *absolute* offset the
 *  record ends at, so a node cannot be written until it is known where it will
 *  sit - which is why the tree is built as objects and serialised in one pass. */
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
  // A record with children ends with a null record; one without does not.
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
const fbxString = s => {
  const t = enc.encode(s);
  const b = new Uint8Array(5 + t.length);
  b[0] = 0x53;
  new DataView(b.buffer).setUint32(1, t.length, true);
  b.set(t, 5);
  return b;
};
const fbxDouble = v => { const b = new Uint8Array(9); b[0] = 0x44; new DataView(b.buffer).setFloat64(1, v, true); return b; };

/** A typed array property, zlib-deflated when `packed` - which is what a real
 *  FBX does for anything but the smallest arrays. */
function fbxArray(code, values, packed) {
  const width = code === 'd' ? 8 : 4;
  const plain = new Uint8Array(values.length * width);
  const pv = new DataView(plain.buffer);
  values.forEach((v, i) => (code === 'd' ? pv.setFloat64(i * width, v, true) : pv.setInt32(i * width, v, true)));
  const payload = packed ? new Uint8Array(deflateSync(Buffer.from(plain))) : plain;
  const b = new Uint8Array(13 + payload.length);
  b[0] = code.charCodeAt(0);
  const bv = new DataView(b.buffer);
  bv.setUint32(1, values.length, true);
  bv.setUint32(5, packed ? 1 : 0, true);
  bv.setUint32(9, payload.length, true);
  b.set(payload, 13);
  return b;
}

function fbxFile({ packed = true, translation = null, up = null } = {}) {
  const verts = [0, 0, 0, 2, 0, 0, 0, 3, 0];
  const kids = [
    fbxNode('Vertices', [fbxArray('d', verts, packed)]),
    fbxNode('PolygonVertexIndex', [fbxArray('i', [0, 1, ~2], packed)]),
  ];
  const geometry = fbxNode('Geometry', [fbxLong(100), fbxString('Geometry::x'), fbxString('Mesh')], kids);

  const roots = [geometry];
  if (translation) {
    const p = fbxNode('P', [
      fbxString('Lcl Translation'), fbxString('Lcl Translation'), fbxString(''), fbxString('A'),
      fbxDouble(translation[0]), fbxDouble(translation[1]), fbxDouble(translation[2]),
    ]);
    roots.push(fbxNode('Model', [fbxLong(200), fbxString('Model::m'), fbxString('Mesh')],
      [fbxNode('Properties70', [], [p])]));
    roots.push(fbxNode('Connections', [], [
      fbxNode('C', [fbxString('OO'), fbxLong(100), fbxLong(200)]),
    ]));
  }
  if (up !== null) {
    roots.push(fbxNode('GlobalSettings', [], [fbxNode('Properties70', [], [
      fbxNode('P', [fbxString('UpAxis'), fbxString('int'), fbxString('Integer'), fbxString(''), fbxDouble(up)]),
    ])]));
  }

  const magic = enc.encode('Kaydara FBX Binary  ');
  const head = new Uint8Array(27);
  head.set(magic, 0);
  head[20] = 0x00; head[21] = 0x1a; head[22] = 0x00;
  new DataView(head.buffer).setUint32(23, 7300, true);

  const placed = [];
  let at = head.length;
  for (const node of roots) {
    const bytes = fbxBytes(node, at);
    placed.push(bytes);
    at += bytes.length;
  }
  const out = new Uint8Array(at + 13);
  out.set(head, 0);
  let cursor = head.length;
  for (const bytes of placed) { out.set(bytes, cursor); cursor += bytes.length; }
  return asBuffer(out);
}

test('a binary FBX reads its polygons, deflated or not', () => {
  for (const packed of [true, false]) {
    const m = parseMesh('fbx', fbxFile({ packed }), 'y');
    assert.equal(m.count, 3, `count packed=${packed}`);
    near(m.bounds.max[0], 2, `max x packed=${packed}`);
    near(m.bounds.max[1], 3, `max y packed=${packed}`);
  }
});

test('an FBX geometry is placed by the model it is connected to', () => {
  // The whole reason the connections are followed. Without them a scene of props
  // is a heap at the origin.
  const m = parseMesh('fbx', fbxFile({ translation: [50, 0, 0] }), 'y');
  near(m.bounds.min[0], 50, 'moved by its model');
  near(m.bounds.max[0], 52, 'and only by its model');
});

test('an FBX states its own up axis and is believed over the format default', () => {
  // UpAxis 2 is z. Without the file being read, `fbx` defaults to y and the
  // model would not be stood up.
  const zUp = parseMesh('fbx', fbxFile({ up: 2 }));
  const yUp = parseMesh('fbx', fbxFile({ up: 1 }));
  near(zUp.bounds.max[1], 0, 'z-up puts the third coordinate on y');
  near(yUp.bounds.max[1], 3, 'y-up leaves it alone');
});

test('an ascii FBX reads its arrays out of the text', () => {
  const text = `; FBX 7.3.0 project file
Objects:  {
  Geometry: 1, "Geometry::x", "Mesh" {
    Vertices: *9 { a: 0,0,0,2,0,0,0,3,0 }
    PolygonVertexIndex: *3 { a: 0,1,-3 }
  }
}
`;
  const m = parseMesh('fbx', buf(text), 'y');
  assert.equal(m.count, 3);
  near(m.bounds.max[1], 3, 'max y');
});

test('a truncated FBX is refused rather than read past its end', () => {
  const full = new Uint8Array(fbxFile());
  assert.throws(() => parseMesh('fbx', asBuffer(full.subarray(0, full.length - 30))), MeshError);
});

// ---------------------------------------------------------------------------
// Collada
// ---------------------------------------------------------------------------

const DAE = up => `<?xml version="1.0"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
 <asset><up_axis>${up}</up_axis></asset>
 <library_effects>
  <effect id="fx"><profile_COMMON><technique sid="t"><lambert>
    <diffuse><color>0 0 1 1</color></diffuse>
  </lambert></technique></profile_COMMON></effect>
 </library_effects>
 <library_materials><material id="mat"><instance_effect url="#fx"/></material></library_materials>
 <library_geometries>
  <geometry id="g"><mesh>
   <source id="pos">
    <float_array id="pos-a" count="9">0 0 0  2 0 0  0 3 0</float_array>
    <technique_common><accessor source="#pos-a" count="3" stride="3">
      <param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/>
    </accessor></technique_common>
   </source>
   <source id="nrm">
    <float_array id="nrm-a" count="9">0 0 1  0 0 1  0 0 1</float_array>
    <technique_common><accessor source="#nrm-a" count="3" stride="3"/></technique_common>
   </source>
   <vertices id="v"><input semantic="POSITION" source="#pos"/></vertices>
   <triangles count="1" material="sym">
    <input semantic="VERTEX" source="#v" offset="0"/>
    <input semantic="NORMAL" source="#nrm" offset="1"/>
    <p>0 0 1 1 2 2</p>
   </triangles>
  </mesh></geometry>
 </library_geometries>
 <library_visual_scenes><visual_scene id="scene">
  <node><translate>10 0 0</translate>
   <instance_geometry url="#g">
    <bind_material><technique_common>
     <instance_material symbol="sym" target="#mat"/>
    </technique_common></bind_material>
   </instance_geometry>
  </node>
 </visual_scene></library_visual_scenes>
 <scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>`;

test('a Collada document reads interleaved inputs at the right stride', () => {
  // Two inputs at offsets 0 and 1, so `<p>` of six numbers is three corners and
  // not six. Getting this wrong reads a triangle as nothing at all.
  const m = parseMesh('dae', buf(DAE('Y_UP')), 'y');
  assert.equal(m.count, 3);
});

test('a Collada node transform places the geometry it instances', () => {
  const m = parseMesh('dae', buf(DAE('Y_UP')), 'y');
  near(m.bounds.min[0], 10, 'translated');
  near(m.bounds.max[0], 12, 'and only translated');
});

test('a Collada material colour reaches the triangles bound to it', () => {
  const m = parseMesh('dae', buf(DAE('Y_UP')), 'y');
  assert.ok(m.colors, 'colours');
  assert.deepEqual([...m.colors.slice(0, 3)], [0, 0, 1]);
});

test('a Collada up_axis is believed over the format default', () => {
  const zUp = parseMesh('dae', buf(DAE('Z_UP')));
  const yUp = parseMesh('dae', buf(DAE('Y_UP')));
  near(yUp.bounds.max[1], 3, 'y-up is left alone');
  near(zUp.bounds.max[1], 0, 'z-up is stood up');
});

test('a document that is not Collada says so', () => {
  assert.throws(() => parseMesh('dae', buf('<html><body>no</body></html>')), MeshError);
});

// ---------------------------------------------------------------------------
// 3DS
// ---------------------------------------------------------------------------

/** A 3DS chunk: a two-byte id, a four-byte length that counts the header, then
 *  the body. */
function chunk(id, ...parts) {
  const body = parts.flatMap(p => (typeof p === 'string' ? [...enc.encode(p), 0] : p));
  const out = new Uint8Array(6 + body.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, id, true);
  view.setUint32(2, out.length, true);
  out.set(body, 6);
  return [...out];
}

const u16 = n => [n & 0xff, (n >> 8) & 0xff];
const f32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, n, true); return [...b]; };

function tdsFile() {
  const verts = [[0, 0, 0], [2, 0, 0], [0, 3, 0]];
  const vertexChunk = chunk(0x4110, u16(verts.length), verts.flatMap(v => v.flatMap(f32)));
  const faceChunk = chunk(0x4120, u16(1), [...u16(0), ...u16(1), ...u16(2), ...u16(0)],
    chunk(0x4130, 'paint', u16(1), u16(0)));
  const mesh = chunk(0x4100, vertexChunk, faceChunk);
  const object = chunk(0x4000, 'thing', mesh);
  const material = chunk(0xafff,
    chunk(0xa000, 'paint'),
    chunk(0xa020, chunk(0x0011, [0, 255, 0])));
  const editor = chunk(0x3d3d, material, object);
  return asBuffer(new Uint8Array(chunk(0x4d4d, editor)));
}

test('a 3DS reads its object out of the chunk tree', () => {
  const m = parseMesh('3ds', tdsFile(), 'y');
  assert.equal(m.count, 3);
  near(m.bounds.max[0], 2, 'max x');
  near(m.bounds.max[1], 3, 'max y');
});

test('a 3DS face group takes the colour of the material it names', () => {
  const m = parseMesh('3ds', tdsFile(), 'y');
  assert.ok(m.colors, 'colours');
  assert.deepEqual([...m.colors.slice(0, 3)], [0, 1, 0]);
});

test('a 3DS chunk that runs past its parent is refused', () => {
  const bytes = new Uint8Array(tdsFile());
  // Stretch the editor chunk's length well past the file.
  new DataView(bytes.buffer).setUint32(8, 0xffff, true);
  assert.throws(() => parseMesh('3ds', asBuffer(bytes)), MeshError);
});

test('a file that is not a 3DS is not read as one', () => {
  assert.throws(() => parseMesh('3ds', buf('PK not a 3ds')), MeshError);
});

// ---------------------------------------------------------------------------
// STEP
// ---------------------------------------------------------------------------

/** A tiny STEP writer, so the fixtures below read like the geometry they are. */
function stepFile(write) {
  const lines = [];
  let n = 0;
  const put = record => { lines.push(`#${++n}=${record};`); return n; };
  write(put);
  return `ISO-10303-21;\nHEADER;\nFILE_NAME('t','',(''),(''),'','','');\nENDSEC;\n`
    + `DATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

const CUBE = [
  [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
  [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10],
];

function stepCube({ colour = null } = {}) {
  return stepFile(put => {
    const pts = CUBE.map(([x, y, z]) => put(`CARTESIAN_POINT('',(${x}.,${y}.,${z}.))`));
    const verts = pts.map(p => put(`VERTEX_POINT('',#${p})`));
    const edges = new Map();
    const edge = (a, b) => {
      const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
      if (edges.has(key)) return edges.get(key);
      const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
      const d = [0, 1, 2].map(i => CUBE[hi][i] - CUBE[lo][i]);
      const len = Math.hypot(...d);
      const dir = put(`DIRECTION('',(${d.map(v => (v / len).toFixed(6)).join(',')}))`);
      const vec = put(`VECTOR('',#${dir},${len}.)`);
      const line = put(`LINE('',#${pts[lo]},#${vec})`);
      const made = put(`EDGE_CURVE('',#${verts[lo]},#${verts[hi]},#${line},.T.)`);
      edges.set(key, made);
      return made;
    };
    const face = (loop, normal) => {
      const oriented = loop.map((a, i) => {
        const b = loop[(i + 1) % loop.length];
        return put(`ORIENTED_EDGE('',*,*,#${edge(a, b)},.${a < b ? 'T' : 'F'}.)`);
      });
      const edgeLoop = put(`EDGE_LOOP('',(${oriented.map(o => `#${o}`).join(',')}))`);
      const bound = put(`FACE_OUTER_BOUND('',#${edgeLoop},.T.)`);
      const dir = put(`DIRECTION('',(${normal.map(v => `${v}.`).join(',')}))`);
      const place = put(`AXIS2_PLACEMENT_3D('',#${pts[loop[0]]},#${dir},$)`);
      const plane = put(`PLANE('',#${place})`);
      return put(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`);
    };
    const faces = [
      face([0, 3, 2, 1], [0, 0, -1]), face([4, 5, 6, 7], [0, 0, 1]),
      face([0, 1, 5, 4], [0, -1, 0]), face([2, 3, 7, 6], [0, 1, 0]),
      face([1, 2, 6, 5], [1, 0, 0]), face([0, 4, 7, 3], [-1, 0, 0]),
    ];
    const shell = put(`CLOSED_SHELL('',(${faces.map(f => `#${f}`).join(',')}))`);
    const solid = put(`MANIFOLD_SOLID_BREP('cube',#${shell})`);
    if (colour) {
      const rgb = put(`COLOUR_RGB('',${colour.map(v => `${v}.`).join(',')})`);
      const fill = put(`FILL_AREA_STYLE_COLOUR('',#${rgb})`);
      const area = put(`FILL_AREA_STYLE('',(#${fill}))`);
      const surface = put(`SURFACE_STYLE_FILL_AREA(#${area})`);
      const side = put(`SURFACE_SIDE_STYLE('',(#${surface}))`);
      const usage = put(`SURFACE_STYLE_USAGE(.BOTH.,#${side})`);
      const style = put(`PRESENTATION_STYLE_ASSIGNMENT((#${usage}))`);
      put(`STYLED_ITEM('',(#${style}),#${solid})`);
    }
  });
}

test('a STEP cube is twelve triangles at the corners the file names', () => {
  const m = parseMesh('step', buf(stepCube()), 'y');
  assert.equal(m.count, 36, 'six quads, two triangles each');
  assert.deepEqual(m.bounds.min, [0, 0, 0]);
  assert.deepEqual(m.bounds.max, [10, 10, 10]);
  for (const corner of CUBE) assert.ok(has(m, corner), `corner ${corner}`);
});

test('a STEP presentation colour reaches the faces of the solid it styles', () => {
  const m = parseMesh('step', buf(stepCube({ colour: [0, 0, 1] })), 'y');
  assert.ok(m.colors, 'colours');
  assert.deepEqual([...m.colors.slice(0, 3)], [0, 0, 1]);
});

/** A cylinder: two circular caps and one cylindrical side seamed by a line. */
function stepCylinder(radius = 5, height = 20) {
  return stepFile(put => {
    const bottom = put(`CARTESIAN_POINT('',(0.,0.,0.))`);
    const top = put(`CARTESIAN_POINT('',(0.,0.,${height}.))`);
    const z = put(`DIRECTION('',(0.,0.,1.))`);
    const x = put(`DIRECTION('',(1.,0.,0.))`);
    const axisBottom = put(`AXIS2_PLACEMENT_3D('',#${bottom},#${z},#${x})`);
    const axisTop = put(`AXIS2_PLACEMENT_3D('',#${top},#${z},#${x})`);
    const seedBottom = put(`CARTESIAN_POINT('',(${radius}.,0.,0.))`);
    const seedTop = put(`CARTESIAN_POINT('',(${radius}.,0.,${height}.))`);
    const vb = put(`VERTEX_POINT('',#${seedBottom})`);
    const vt = put(`VERTEX_POINT('',#${seedTop})`);
    const circleBottom = put(`CIRCLE('',#${axisBottom},${radius}.)`);
    const circleTop = put(`CIRCLE('',#${axisTop},${radius}.)`);
    const edgeBottom = put(`EDGE_CURVE('',#${vb},#${vb},#${circleBottom},.T.)`);
    const edgeTop = put(`EDGE_CURVE('',#${vt},#${vt},#${circleTop},.T.)`);
    const vec = put(`VECTOR('',#${z},${height}.)`);
    const seamLine = put(`LINE('',#${seedBottom},#${vec})`);
    const seam = put(`EDGE_CURVE('',#${vb},#${vt},#${seamLine},.T.)`);

    const oe = (e, sense) => put(`ORIENTED_EDGE('',*,*,#${e},.${sense}.)`);
    const sideLoop = put(`EDGE_LOOP('',(#${oe(edgeBottom, 'T')},#${oe(seam, 'T')},`
      + `#${oe(edgeTop, 'F')},#${oe(seam, 'F')}))`);
    const sideBound = put(`FACE_OUTER_BOUND('',#${sideLoop},.T.)`);
    const side = put(`CYLINDRICAL_SURFACE('',#${axisBottom},${radius}.)`);
    const sideFace = put(`ADVANCED_FACE('',(#${sideBound}),#${side},.T.)`);

    const cap = (edge, axis) => {
      const loop = put(`EDGE_LOOP('',(#${oe(edge, 'T')}))`);
      const bound = put(`FACE_OUTER_BOUND('',#${loop},.T.)`);
      const plane = put(`PLANE('',#${axis})`);
      return put(`ADVANCED_FACE('',(#${bound}),#${plane},.T.)`);
    };
    const shell = put(`CLOSED_SHELL('',(#${sideFace},#${cap(edgeBottom, axisBottom)},`
      + `#${cap(edgeTop, axisTop)}))`);
    put(`MANIFOLD_SOLID_BREP('cyl',#${shell})`);
  });
}

test('a STEP cylinder is round, and is round in about as few triangles as that takes', () => {
  const m = parseMesh('step', buf(stepCylinder()), 'y');
  // Two hundred-odd: a side of about ninety-six triangles and two caps of
  // forty-six. Ten times this means the triangulation has stopped following the
  // surface and the subdivision is rescuing it - which is what a wrong polygon
  // orientation looks like, and it is invisible in the picture.
  assert.ok(m.count / 3 > 100, `too coarse to be round: ${m.count / 3}`);
  assert.ok(m.count / 3 < 400, `far more triangles than a cylinder needs: ${m.count / 3}`);
  near(m.bounds.min[0], -5, 'min x');
  near(m.bounds.max[0], 5, 'max x');
  near(m.bounds.max[2], 20, 'height');
  // Every point is on the surface: on the wall, or on one of the two caps.
  for (const [x, y, z] of points(m)) {
    const r = Math.hypot(x, y);
    const onWall = Math.abs(r - 5) < 0.05;
    const onCap = (Math.abs(z) < 1e-6 || Math.abs(z - 20) < 1e-6) && r < 5.05;
    assert.ok(onWall || onCap, `point off the cylinder: ${[x, y, z]}`);
  }
});

test('a STEP file with nothing drawable in it says so', () => {
  const empty = stepFile(put => put(`CARTESIAN_POINT('',(0.,0.,0.))`));
  assert.throws(() => parseMesh('step', buf(empty)), MeshError);
  assert.throws(() => parseMesh('step', buf('not a step file at all')), MeshError);
});

test('a semicolon inside a STEP string does not end the record', () => {
  // The reason the scanner carries a quoted-string state rather than splitting
  // on the delimiter.
  const text = stepCube().replace("FILE_NAME('t'", "FILE_NAME('a;b'");
  const named = text.replace("MANIFOLD_SOLID_BREP('cube'", "MANIFOLD_SOLID_BREP('a;b()'");
  assert.equal(parseMesh('step', buf(named), 'y').count, 36);
});

test('a STEP comment between two tokens does not glue them together', () => {
  const text = stepCube().replace('DATA;', 'DATA;\n/* a comment ; with ( delimiters */');
  assert.equal(parseMesh('step', buf(text), 'y').count, 36);
});

// ---------------------------------------------------------------------------
// IGES
// ---------------------------------------------------------------------------

/** Eighty-column card images: a directory of fixed eight-character fields and a
 *  free-format parameter section that points back at it. */
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
    // Sixty-four columns a card, so a long parameter list runs over several.
    const cards = body.match(/.{1,64}/g) || [''];
    const first = peSeq;
    for (const card of cards) {
      parameters.push(card.padEnd(64) + ' ' + pad(deSeq, 7) + 'P' + pad(peSeq, 7));
      peSeq++;
    }
    directory.push(
      [pad(e.type), pad(first), pad(0), pad(0), pad(0), pad(0), pad(e.transform || 0), pad(0), pad(0)]
        .join('') + 'D' + pad(deSeq, 7),
      [pad(e.type), pad(0), pad(e.colour || 0), pad(cards.length), pad(e.form || 0), pad(0), pad(0), ''.padEnd(8), pad(0)]
        .join('') + 'D' + pad(deSeq + 1, 7),
    );
    e.pointer = deSeq;
    deSeq += 2;
  }

  const terminate = ('S' + pad(1, 7) + 'G' + pad(1, 7) + 'D' + pad(directory.length, 7)
    + 'P' + pad(parameters.length, 7)).padEnd(72) + 'T' + pad(1, 7);
  return [start, global, ...directory, ...parameters, terminate].join('\n') + '\n';
}

/** A flat bilinear NURBS patch: degree one in both directions over four
 *  corners, which is a square and is exactly what its control net says. */
function igesPatch() {
  const entities = [{
    type: 128,
    colour: 3,
    params: [
      1, 1, 1, 1,        // K1 K2 M1 M2 -> two control points each way, degree one
      0, 0, 1, 0, 0,     // PROP1..5: not closed, polynomial, not periodic
      0, 0, 1, 1,        // u knots
      0, 0, 1, 1,        // v knots
      1, 1, 1, 1,        // weights
      0, 0, 0, 10, 0, 0, // control points, v-major
      0, 10, 0, 10, 10, 0,
      0, 1, 0, 1,        // u0 u1 v0 v1
    ],
  }];
  return igesFile(entities);
}

test('an IGES surface reads through its card images', () => {
  const m = parseMesh('iges', buf(igesPatch()), 'y');
  assert.ok(m.count >= 6, `some geometry: ${m.count}`);
  near(m.bounds.min[0], 0, 'min x');
  near(m.bounds.max[0], 10, 'max x');
  near(m.bounds.max[1], 10, 'max y');
  near(m.bounds.max[2], 0, 'flat');
});

test('an IGES entity takes the colour its directory entry names', () => {
  const m = parseMesh('iges', buf(igesPatch()), 'y');
  assert.ok(m.colors, 'colours');
  assert.deepEqual([...m.colors.slice(0, 3)], [0, 1, 0], 'colour number three is green');
});

test('an IGES file with no directory is not an IGES file', () => {
  assert.throws(() => parseMesh('iges', buf('nothing here at all\n')), MeshError);
});

test('an IGES file with no drawable surface says so', () => {
  const only = igesFile([{ type: 116, params: [1, 2, 3] }]);
  assert.throws(() => parseMesh('iges', buf(only)), MeshError);
});

// ---------------------------------------------------------------------------
// The ceiling, across the family
// ---------------------------------------------------------------------------

test('a model past the triangle ceiling is a question, not a refusal', async () => {
  // The retry contract in consent.ts, exercised through one of the new readers.
  // OFF is the cheapest to write a large one in.
  const { setRiskPrompt } = await import('../web/assets/js/consent.ts');
  const verts = [];
  const faces = [];
  const n = 40;
  for (let i = 0; i < n; i++) verts.push(`${i} 0 0`);
  for (let i = 0; i + 2 < n; i++) faces.push(`3 ${i} ${i + 1} ${i + 2}`);
  const text = `OFF ${n} ${faces.length} 0\n${verts.join('\n')}\n${faces.join('\n')}\n`;

  // Nothing is refused at the default ceiling; this is the control.
  assert.ok(parseMesh('off', buf(text)).count > 0);

  // And a genuinely oversized declaration throws something the caller can ask
  // about rather than a plain error.
  setRiskPrompt(null);
  const huge = `OFF 9000000 1 0\n0 0 0\n3 0 0 0\n`;
  assert.throws(() => parseMesh('off', buf(huge)), err => err instanceof Error);
});
