// The orbit camera, checked by arithmetic. Exists because of a shipped bug
// looked at several times without being seen: the up vector was `f x r`
// where it should be `r x f` - both unit length, both perpendicular to the
// view direction, "orthonormal by construction" true of either, so reading
// the code proved nothing. A negated up mirrors the picture down the
// vertical rather than flipping it upside down - invisible to the eye,
// loud in a determinant, which is what's tested.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { join } from 'node:path';

import { frame, modelRadius, orbitView } from '../web/assets/js/canvas/model.ts';
import { appCss, JS, read } from './helpers.js';

/** Column-major 4x4 -> the three basis vectors the matrix's rotation holds. */
function basis(m) {
  // Columns are (r.x, u.x, -f.x, 0) and so on, so a row of storage is one
  // basis vector: right is m[0], m[4], m[8].
  return {
    right: [m[0], m[4], m[8]],
    up: [m[1], m[5], m[9]],
    back: [m[2], m[6], m[10]],
  };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.hypot(...a);
const det3 = (a, b, c) =>
  a[0] * (b[1] * c[2] - b[2] * c[1])
  - a[1] * (b[0] * c[2] - b[2] * c[0])
  + a[2] * (b[0] * c[1] - b[1] * c[0]);

/** Where the camera is, in world space, recovered from the matrix. */
function eyeOf(m) {
  const { right, up, back } = basis(m);
  const t = [m[12], m[13], m[14]];
  return [0, 1, 2].map(i => -(t[0] * right[i] + t[1] * up[i] + t[2] * back[i]));
}

/** A point through the view matrix, which is what the shader actually does. */
function apply(m, p) {
  return [0, 1, 2].map(i => m[i] * p[0] + m[4 + i] * p[1] + m[8 + i] * p[2] + m[12 + i]);
}

const ANGLES = [];
for (const yaw of [0, 0.6, 2.2, -1.1, 5.9]) {
  for (const pitch of [0, 0.5, -0.5, 1.4, -1.4]) ANGLES.push([yaw, pitch]);
}

test('the camera basis is orthonormal', () => {
  for (const [yaw, pitch] of ANGLES) {
    const { right, up, back } = basis(orbitView([0, 0, 0], 5, yaw, pitch));
    for (const [name, v] of [['right', right], ['up', up], ['back', back]]) {
      assert.ok(Math.abs(len(v) - 1) < 1e-6, `${name} is ${len(v)} long at ${yaw},${pitch}`);
    }
    assert.ok(Math.abs(dot(right, up)) < 1e-6, `right and up are not square at ${yaw},${pitch}`);
    assert.ok(Math.abs(dot(right, back)) < 1e-6);
    assert.ok(Math.abs(dot(up, back)) < 1e-6);
  }
});

test('the camera basis is right-handed, so nothing is mirrored', () => {
  // The determinant is +1 for a rotation, -1 with a reflection in it - the
  // assertion the old code failed.
  for (const [yaw, pitch] of ANGLES) {
    const { right, up, back } = basis(orbitView([0, 0, 0], 5, yaw, pitch));
    const d = det3(right, up, back);
    assert.ok(Math.abs(d - 1) < 1e-6, `determinant is ${d.toFixed(3)} at ${yaw},${pitch}`);
  }
});

test('up points up', () => {
  // Not implied by the determinant: a basis rolled 180 degrees about the
  // view axis is still right-handed and still shows the model on its head.
  // The orbit never rolls, so within the pitch clamp up.y is positive.
  for (const [yaw, pitch] of ANGLES) {
    const { up } = basis(orbitView([0, 0, 0], 5, yaw, pitch));
    assert.ok(up[1] > 0, `up.y is ${up[1].toFixed(3)} at yaw ${yaw}, pitch ${pitch}`);
  }
});

test('the model ends up in front of the camera, dist away', () => {
  // The other half of a view matrix, invisible to a basis test: the
  // translation. WebGL looks down -Z, so the centre must land at
  // (0, 0, -dist) whatever the angles or the model's position in world space.
  for (const [yaw, pitch] of ANGLES) {
    for (const centre of [[0, 0, 0], [12, -3, 40], [-1000, 5, 0.5]]) {
      const p = apply(orbitView(centre, 7, yaw, pitch), centre);
      assert.ok(Math.abs(p[0]) < 1e-4 && Math.abs(p[1]) < 1e-4,
        `centre is off axis: ${p.map(n => n.toFixed(3))}`);
      assert.ok(Math.abs(p[2] + 7) < 1e-4, `centre is at z ${p[2].toFixed(3)}, wanted -7`);
    }
  }
});

test('dragging down shows the top of the model', () => {
  // The usual convention: you're pulling the front of the object towards
  // you, so the top comes over. Drag down raises `pitch`, so a positive
  // pitch must put the camera *above* the model.
  //
  // Read off the view matrix rather than the formula, so the test can't
  // agree with the code by restating it. The translation column holds
  // -(b . e) for each basis vector b, and the basis is orthonormal, so the
  // eye comes back as -(t0.b0 + t1.b1 + t2.b2).
  for (const pitch of [0.2, 0.8, 1.4]) {
    for (const yaw of [0, 1.3, -2.7]) {
      assert.ok(eyeOf(orbitView([0, 0, 0], 5, yaw, pitch))[1] > 0,
        `pitch ${pitch} at yaw ${yaw} put the camera below the model`);
      assert.ok(eyeOf(orbitView([0, 0, 0], 5, yaw, -pitch))[1] < 0,
        `pitch ${-pitch} at yaw ${yaw} put the camera above the model`);
    }
  }
});

test('swiping right turns the model right', () => {
  // The companion to the pitch test, same convention: you have hold of the
  // object. Swiping right raises `yaw`, so the face pointing at you must
  // move right on screen, meaning the camera orbits left. Backwards here
  // is the complaint "the controls are mirrored", invisible on anything symmetric.
  //
  // Measured on the front of the model, in view space, +x to the right.
  for (const yaw of [0.15, 0.4, 0.9]) {
    const front = apply(orbitView([0, 0, 0], 5, yaw, 0), [0, 0, 1]);
    assert.ok(front[0] > 0, `yaw ${yaw} sent the front face to x ${front[0].toFixed(3)}`);
    const back = apply(orbitView([0, 0, 0], 5, -yaw, 0), [0, 0, 1]);
    assert.ok(back[0] < 0, `yaw ${-yaw} sent the front face to x ${back[0].toFixed(3)}`);
  }
});

test('yaw turns the model about the vertical, not about the camera', () => {
  // A point directly above the centre must stay directly above it through
  // a whole turn. It won't if up and forward swapped roles - the other way
  // this parameterisation gets written wrong.
  for (let yaw = 0; yaw < 6.2; yaw += 0.4) {
    const p = apply(orbitView([0, 0, 0], 5, yaw, 0), [0, 2, 0]);
    assert.ok(Math.abs(p[0]) < 1e-4, `the top of the model slid sideways to ${p[0]}`);
    assert.ok(p[1] > 1.9, `the top of the model is at height ${p[1]}`);
  }
});

// ---------------------------------------------------------------------------
// The framing, and the shape of the still
// ---------------------------------------------------------------------------
//
// WebGL canvas while turning, WebP still at rest — both must land on the
// same pixels. Framing uses the bounding sphere on the narrow axis so a
// model never changes size as you turn it.

const near = (a, b, msg, eps) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

/** A box, as bounds centred on the origin. */
const box = (x, y, z) => ({ min: [-x / 2, -y / 2, -z / 2], max: [x / 2, y / 2, z / 2] });

/**
 * A mesh with real vertices, so modelRadius() has something to read.
 * `shell` puts points on the box's corners, where the box diagonal is the
 * honest answer. `barrel` puts them on an inscribed cylinder, where it
 * isn't - what most machined parts actually are.
 */
function mesh(bounds, kind = 'shell') {
  const { min, max } = bounds;
  const c = [0, 1, 2].map(k => (min[k] + max[k]) / 2);
  const out = [];
  if (kind === 'shell') {
    for (const x of [min[0], max[0]]) {
      for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push(x, y, z);
    }
  } else {
    const rx = (max[0] - min[0]) / 2, ry = (max[1] - min[1]) / 2;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      for (const z of [min[2], max[2]]) out.push(c[0] + rx * Math.cos(a), c[1] + ry * Math.sin(a), z);
    }
  }
  return { bounds, positions: new Float32Array(out) };
}

/** The model's diameter in pixels, drawn into a w x h canvas. */
const drawn = (radius, w, h, zoom = 1) => {
  const f = frame(radius, zoom, w, h);
  return 2 * f.tan * f.scale;
};

test('the model is the same size at every angle, which is the whole rule', () => {
  // Not a sweep over `frame` - it takes no angle at all, and that's the
  // assertion. A framing that could resize a turning model would need one.
  assert.equal(frame.length, 4, 'frame() grew an argument - if one of them is an angle, that is the bug');
  const r = modelRadius(mesh(box(300, 100, 4)));
  for (const [w, h] of [[400, 400], [800, 300], [300, 800], [222, 197]]) {
    near(drawn(r, w, h), Math.min(w, h) / 1.12, `${w}x${h}`, 1e-9);
  }
});

test('the model never leaves the frame, which is what the margin buys', () => {
  // FIT_MARGIN is air and must stay air. The sphere contains every vertex,
  // so this holds at every angle by construction, which the silhouette fit
  // couldn't claim.
  for (const bounds of [box(1, 1, 1), box(300, 100, 4), box(4, 4, 400)]) {
    for (const kind of ['shell', 'barrel']) {
      const r = modelRadius(mesh(bounds, kind));
      for (const [w, h] of [[400, 400], [800, 300], [300, 800], [222, 197]]) {
        assert.ok(drawn(r, w, h) < Math.min(w, h), `${w}x${h} clips a ${kind}`);
      }
    }
  }
});

test('a stage-shaped still lands exactly where the live canvas would draw it', () => {
  // The still/live contract. takeShot() measures the stage and shoots at
  // its proportions; the card contains that picture back into the same
  // box. The claim: the result is what frame() draws straight into the stage.
  //
  // Both the matched shape and the square fallback: an unmounted card has
  // no box to measure and squares up, and fit being min(w, h) makes that
  // fallback exact, not merely close.
  const contain = (bw, bh, iw, ih) => Math.min(bw / iw, bh / ih);
  const r = modelRadius(mesh(box(120, 80, 60)));
  for (const [bw, bh] of [[222, 197], [222, 257], [382, 217], [242, 357], [100, 700]]) {
    const edge = 900;
    for (const shape of [bw / bh, 1]) {
      const iw = shape >= 1 ? edge : Math.max(1, Math.round(edge * shape));
      const ih = shape >= 1 ? Math.max(1, Math.round(edge / shape)) : edge;
      const still = drawn(r, iw, ih) * contain(bw, bh, iw, ih);
      // Within a pixel: iw and ih are whole numbers, the stage's shape isn't.
      near(still, drawn(r, bw, bh), `a ${bw}x${bh} stage at ${shape.toFixed(2)}`, 1.5);
    }
  }
});

test('a card-shaped still does not, which is the bug that started all this', () => {
  // Kept as a test, not a comment: someone restoring "the card's own
  // proportions" should find this red. The card is taller than wide; its
  // stage, minus filename and padding, is wider than tall. That inversion
  // is the whole failure.
  const r = modelRadius(mesh(box(120, 80, 60)));
  const [cw, ch] = [240, 300];
  const [bw, bh] = [222, 257];
  const iw = Math.round(900 * (cw / ch)), ih = 900;
  const matched = drawn(r, iw, ih) * Math.min(bw / iw, bh / ih);
  assert.ok(Math.abs(matched / drawn(r, bw, bh) - 1) > 0.05,
    'a card-shaped still now agrees with the live canvas - if that is a real fix, '
    + 'this test is the thing to delete, not stageShape()');
});

test('the radius is the model, not the box it came in', () => {
  // The air that can honestly be taken back. A barrel inscribed in its box
  // never reaches the corners, so framing by box diagonal draws it smaller
  // than it needs to be, every card, every angle.
  const bounds = box(100, 100, 40);
  const shell = modelRadius(mesh(bounds, 'shell'));
  const barrel = modelRadius(mesh(bounds, 'barrel'));
  near(shell, Math.hypot(50, 50, 20), 'a box of corners is not its own diagonal', 1e-4);
  near(barrel, Math.hypot(50, 20), 'a barrel is measured as though it had corners', 1e-3);
  assert.ok(barrel < shell * 0.85, `the tighter sphere is not tighter: ${barrel} vs ${shell}`);
});

test('zoom scales the model', () => {
  const r = modelRadius(mesh(box(120, 80, 60)));
  near(drawn(r, 400, 400, 2) / drawn(r, 400, 400, 1), 2, 'zoom does not scale', 1e-9);
  // Rubbish in the stored view is a card, not a crash: liveView() coerces,
  // and this is the second line of that defence.
  near(drawn(r, 400, 400, 0), drawn(r, 400, 400, 1), 'a zero zoom is not ignored', 1e-9);
});

// ---------------------------------------------------------------------------
// And the rule that has to be reached for any of the above to be true
// ---------------------------------------------------------------------------
//
// Every assertion above is about `object-fit: contain`, and the arithmetic
// was right while the CSS wasn't: `.model-still` is one class, `.item-body
// img` a class and a type, so the generic rule won and the still drew
// `cover` at a scale the live canvas never used. Nothing was red - the
// picture still jumped the moment you stopped turning the model.
//
// So specificity is asserted, not the declaration. A rule that says
// `contain` and loses is the same as no rule at all.

/**
 * A selector's specificity as [ids, classes, types]. Only as much of a
 * parser as these two selectors need - a general one is a project.
 * `[\w-]` after the dot so `.card-model` counts once; the type arm
 * requires a combinator or string start so `model` inside `.card-model`
 * isn't read as an element.
 */
function specificity(selector) {
  return [
    (selector.match(/#[\w-]+/g) || []).length,
    (selector.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) || []).length,
    (selector.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) || []).length,
  ];
}

/** Does `a` win over `b` on specificity alone, whatever the source order? */
const beats = (a, b) => {
  const [x, y] = [specificity(a), specificity(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// ---------------------------------------------------------------------------
// And the ceiling that is not there
// ---------------------------------------------------------------------------
//
// Read off the source rather than the exports, as tests/csp.test.js does
// with worker URLs: these are internal constants and a deleted function,
// and exporting them just to hold a rule in place would widen the module's
// surface.

test('the still is never refused for being too big for its card', () => {
  const src = read(join(JS, 'canvas', 'model.ts'));

  // The identity this rests on: drawInto() clamps the *live* buffer to
  // MAX_BUFFER, so a card bigger than that upscales the geometry too -
  // which makes "always photograph it" safe. One constant assigned from
  // the other so they can't drift; a literal here would quietly soften
  // the still.
  assert.match(src, /const SHOT_MAX = MAX_BUFFER;/,
    'SHOT_MAX is no longer tied to MAX_BUFFER - a still can now be softer than the live canvas');

  // Three values of this ceiling were reached by ordinary use, each time
  // reverting the card to re-reading its geometry on every load. A card
  // 1500px wide was the last one - not a number to raise again.
  assert.equal(src.includes('outgrewStill'), false,
    'the size ceiling is back - see SHOT_MAX for the three times it was wrong');
});

test('the specificity parser answers the two cases it is here for', () => {
  // Checked first: a wrong parser would pass the assertion below while the
  // CSS was still broken, the failure this section exists to catch.
  assert.deepEqual(specificity('.item-body img'), [0, 1, 1]);
  assert.deepEqual(specificity('.card-model .model-still'), [0, 2, 0]);
  assert.deepEqual(specificity('.model-still'), [0, 1, 0]);
  assert.ok(!beats('.model-still', '.item-body img'), 'the shipped bug reads as a win');
});

test('the model still is fitted by a rule that actually reaches it', () => {
  const css = appCss();
  // The generic rule it has to out-specify. Asserted, not assumed: if this
  // stops saying `cover` the fix below stops being load-bearing.
  assert.match(css, /\.item-body img,\s*\n\s*\.item-body video\s*\{[^}]*object-fit:\s*cover/,
    '.item-body img no longer forces cover - re-read the model still rule');

  // Read out of the CSS rather than written here, so this tests the
  // stylesheet, not a string in a test.
  const rule = css.match(/([^{}]*\.model-still[^{}]*)\{([^}]*)\}/);
  assert.ok(rule, 'no rule in the app CSS mentions .model-still');
  const [, selector, body] = rule;
  assert.match(body, /object-fit:\s*contain/, 'the model still is not fitted `contain`');
  assert.ok(beats(selector.trim(), '.item-body img'),
    `\`${selector.trim()}\` loses to \`.item-body img\`, so the still is drawn cover: `
    + `${JSON.stringify(specificity(selector.trim()))} vs [0,1,1]`);
});

test('the zoomed-out twin is swapped in for the model as it is for a photograph', () => {
  const css = appCss();
  // The two rules the model card's twin rides on, written once in
  // items.css against `.item-body`, so the model gets the swap just by
  // mounting a sibling `<img class="still">`. A rule narrowed to
  // photographs would silently leave a model card decoding a 900px still
  // at a hundred-pixel zoom.
  assert.match(css, /#world\.is-stilled \.item-body img\.still\.is-ready\s*\{\s*display:\s*block/);
  assert.match(css, /#world\.is-stilled \.item-body img:not\(\.still\):has\(\+ \.still\.is-ready\)/);
});
