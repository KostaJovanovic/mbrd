// The orbit camera, checked by arithmetic.
//
// This exists because of a bug that shipped and was looked at several times
// without being seen: the up vector was `f x r` where it should have been
// `r x f`. Both are unit length, both are perpendicular to the view direction,
// and "orthonormal by construction" is true of either - so reading the code
// proves nothing and the render is not obviously wrong either. A negated up
// makes the camera basis left-handed, so the picture comes out *mirrored* down
// the vertical rather than upside down, which on a symmetric part reads as
// nothing much until you notice the model turns the wrong way under the drag.
//
// A mirror is invisible to the eye and loud in a determinant, so that is what
// is tested.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { join } from 'node:path';

import { frame, modelRadius, orbitView } from '../web/assets/js/canvas/model.ts';
import { appCss, JS, read } from './helpers.js';

/** Column-major 4x4 -> the three basis vectors the matrix's rotation holds. */
function basis(m) {
  // Columns are (r.x, u.x, -f.x, 0) and so on, so a row of the storage is one
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
  // The determinant is +1 for a rotation and -1 for a rotation with a
  // reflection in it. This is the assertion the old code failed.
  for (const [yaw, pitch] of ANGLES) {
    const { right, up, back } = basis(orbitView([0, 0, 0], 5, yaw, pitch));
    const d = det3(right, up, back);
    assert.ok(Math.abs(d - 1) < 1e-6, `determinant is ${d.toFixed(3)} at ${yaw},${pitch}`);
  }
});

test('up points up', () => {
  // Not implied by the determinant: a basis rolled 180 degrees about the view
  // axis is still right-handed and still shows the model on its head. The
  // orbit never rolls, so within the pitch clamp the up vector's Y is positive.
  for (const [yaw, pitch] of ANGLES) {
    const { up } = basis(orbitView([0, 0, 0], 5, yaw, pitch));
    assert.ok(up[1] > 0, `up.y is ${up[1].toFixed(3)} at yaw ${yaw}, pitch ${pitch}`);
  }
});

test('the model ends up in front of the camera, dist away', () => {
  // The other half of a view matrix, and the half a basis test cannot see: the
  // translation. WebGL looks down -Z, so the centre must land at (0, 0, -dist)
  // whatever the angles or wherever the model happens to sit in world space.
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
  // The convention the rest of the world uses, and the one file-analyser's STL
  // viewer uses: you are pulling the front of the object towards you, so the
  // top comes over. Drag down raises `pitch`, so a positive pitch has to put the
  // camera *above* the model.
  //
  // Read off the view matrix rather than off the formula, so the test cannot
  // agree with the code by restating it. The translation column holds -(b . e)
  // for each basis vector b, and the basis is orthonormal, so the eye comes back
  // as -(t0.b0 + t1.b1 + t2.b2).
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
  // The companion to the pitch test, and the same convention: you have hold of
  // the object. Swiping right raises `yaw`, so the face that was pointing at
  // you has to move towards the right of the screen - which means the camera
  // orbits left. Getting this backwards is the complaint "the controls are
  // mirrored", and it is invisible on anything with a symmetry.
  //
  // Measured on the front of the model, in view space, where +x is to the right.
  for (const yaw of [0.15, 0.4, 0.9]) {
    const front = apply(orbitView([0, 0, 0], 5, yaw, 0), [0, 0, 1]);
    assert.ok(front[0] > 0, `yaw ${yaw} sent the front face to x ${front[0].toFixed(3)}`);
    const back = apply(orbitView([0, 0, 0], 5, -yaw, 0), [0, 0, 1]);
    assert.ok(back[0] < 0, `yaw ${-yaw} sent the front face to x ${back[0].toFixed(3)}`);
  }
});

test('yaw turns the model about the vertical, not about the camera', () => {
  // A point directly above the centre has to stay directly above it on screen
  // through a whole turn. It does not if up and forward have swapped roles,
  // which is the other way this parameterisation gets written wrong.
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
// A model card shows one of two things: a WebGL canvas while you are turning it,
// and a WebP photograph the rest of the time. They are two renders of one scene
// and they have to land on the same pixels, or the model changes size the moment
// you let go - which is exactly what it did.
//
// The still is drawn into the stage's box by `object-fit: contain`, and the
// stage is not the card: it is the card less its padding, less the filename,
// less the gap above it. So the two boxes are different shapes, and any framing
// rule that reads the box's shape has to survive that. What follows is the
// arithmetic that makes them agree anyway.
//
// The rule is the model's bounding sphere on the narrow axis. A sphere is the
// same measurement in every direction, which is the point: **a model must not
// change size as you turn it over.** Fitting the silhouette instead fills the
// card far better and makes the part breathe for the whole gesture, which was
// tried and was worse than the air it saved. What is left to win is the size of
// the sphere, and that is modelRadius()'s business, not the framing's.

const near = (a, b, msg, eps) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

/** A box, as bounds centred on the origin. */
const box = (x, y, z) => ({ min: [-x / 2, -y / 2, -z / 2], max: [x / 2, y / 2, z / 2] });

/**
 * A mesh with real vertices, so modelRadius() has something to read.
 *
 * `shell` puts its points on the box's corners, which is the case where the box
 * diagonal is the honest answer. `barrel` puts them on a cylinder inscribed in
 * it, which is the case where the box diagonal is not - and which is what most
 * machined parts actually are.
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
  // Not a sweep over `frame` - it takes no angle at all, and that is the
  // assertion. A framing that could resize a turning model would have to be
  // handed one, so the signature is the test and this says so out loud.
  assert.equal(frame.length, 4, 'frame() grew an argument - if one of them is an angle, that is the bug');
  const r = modelRadius(mesh(box(300, 100, 4)));
  for (const [w, h] of [[400, 400], [800, 300], [300, 800], [222, 197]]) {
    near(drawn(r, w, h), Math.min(w, h) / 1.12, `${w}x${h}`, 1e-9);
  }
});

test('the model never leaves the frame, which is what the margin buys', () => {
  // FIT_MARGIN is air and the air has to be air. The sphere contains every
  // vertex, so this holds at every angle by construction rather than by sweep -
  // which is exactly what the silhouette fit could not claim.
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
  // The still/live contract. takeShot() measures the stage and shoots at its
  // proportions; the card contains that picture back into the same box. The
  // claim is that the result is what frame() draws straight into the stage.
  //
  // Both the matched shape and the square fallback, because a card that is not
  // mounted has no box to measure and squares up - and the fit being min(w, h)
  // is what makes that fallback exact rather than merely close.
  const contain = (bw, bh, iw, ih) => Math.min(bw / iw, bh / ih);
  const r = modelRadius(mesh(box(120, 80, 60)));
  for (const [bw, bh] of [[222, 197], [222, 257], [382, 217], [242, 357], [100, 700]]) {
    const edge = 900;
    for (const shape of [bw / bh, 1]) {
      const iw = shape >= 1 ? edge : Math.max(1, Math.round(edge * shape));
      const ih = shape >= 1 ? Math.max(1, Math.round(edge / shape)) : edge;
      const still = drawn(r, iw, ih) * contain(bw, bh, iw, ih);
      // Within a pixel: iw and ih are whole numbers and the stage's shape is not.
      near(still, drawn(r, bw, bh), `a ${bw}x${bh} stage at ${shape.toFixed(2)}`, 1.5);
    }
  }
});

test('a card-shaped still does not, which is the bug that started all this', () => {
  // Kept as a test rather than a comment: someone restoring "the card's own
  // proportions" for the obvious-sounding reason should find this red. The card
  // is taller than it is wide; its stage, once the filename and the padding come
  // off, is wider than it is tall. That inversion is the whole failure.
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
  // The air that can honestly be taken back. A barrel inscribed in its bounding
  // box reaches the box's corners nowhere, and framing it by the box diagonal
  // draws it smaller than it needs to be on every card at every angle.
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
  // Rubbish in the stored view is a card, not a crash: liveView() coerces, and
  // this is the second line of that defence.
  near(drawn(r, 400, 400, 0), drawn(r, 400, 400, 1), 'a zero zoom is not ignored', 1e-9);
});

// ---------------------------------------------------------------------------
// And the rule that has to be reached for any of the above to be true
// ---------------------------------------------------------------------------
//
// Every assertion above is about `object-fit: contain`, and the arithmetic was
// right while the CSS was not: `.model-still` is one class, `.item-body img` is
// a class and a type, so the generic rule won and the still was drawn `cover` -
// cropped to fill, at a scale the live canvas never used. Nothing was red. The
// square, the framing and the four tests above all held, and the picture on
// screen still jumped the moment you stopped turning the model.
//
// So the specificity is asserted, not the declaration. A rule that says
// `contain` and loses is the same as no rule at all.

/**
 * A selector's specificity as [ids, classes, types].
 *
 * Only as much of a parser as these two selectors need, and deliberately no
 * more - a general one is a project. `[\w-]` after the dot so `.card-model`
 * counts once, and the type arm requires a combinator or the string start
 * before the name so the `model` inside `.card-model` is not read as an
 * element.
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
// Read off the source rather than the exports, which is what tests/csp.test.js
// does with the worker URLs and for the same reason: these are two internal
// constants and a deleted function, and exporting them so a test can look would
// be widening the module's surface to hold a rule in place.

test('the still is never refused for being too big for its card', () => {
  const src = read(join(JS, 'canvas', 'model.ts'));

  // The identity the whole arrangement rests on. drawInto() clamps the *live*
  // buffer to MAX_BUFFER, so on a card bigger than that the geometry is being
  // upscaled too - which is what makes "always photograph it" safe. Written as
  // one constant assigned from the other so the two cannot drift; a literal here
  // would be a still quietly softer than the thing it stands in for.
  assert.match(src, /const SHOT_MAX = MAX_BUFFER;/,
    'SHOT_MAX is no longer tied to MAX_BUFFER - a still can now be softer than the live canvas');

  // Three values of this ceiling were reached by ordinary use, and each time the
  // card stopped being a photograph and went back to re-reading its geometry on
  // every load. A card 1500px wide was the last one. It is not a number that
  // wants raising again.
  assert.equal(src.includes('outgrewStill'), false,
    'the size ceiling is back - see SHOT_MAX for the three times it was wrong');
});

test('the specificity parser answers the two cases it is here for', () => {
  // The test's own instrument, checked first: a wrong parser would pass the
  // assertion below while the CSS was still broken, which is the failure this
  // whole section exists to stop happening twice.
  assert.deepEqual(specificity('.item-body img'), [0, 1, 1]);
  assert.deepEqual(specificity('.card-model .model-still'), [0, 2, 0]);
  assert.deepEqual(specificity('.model-still'), [0, 1, 0]);
  assert.ok(!beats('.model-still', '.item-body img'), 'the shipped bug reads as a win');
});

test('the model still is fitted by a rule that actually reaches it', () => {
  const css = appCss();
  // The generic rule it has to out-specify. Asserted rather than assumed: if
  // this stops saying `cover` the fix below is no longer load-bearing, and
  // somebody should find that out here rather than by reading two files.
  assert.match(css, /\.item-body img,\s*\n\s*\.item-body video\s*\{[^}]*object-fit:\s*cover/,
    '.item-body img no longer forces cover - re-read the model still rule');

  // The app's own selector, read out of the CSS rather than written here, so
  // this is a test about the stylesheet and not about a string in a test.
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
  // The two rules the model card's twin rides on. They are written once, in
  // items.css, against `.item-body` - so the model gets the swap by mounting a
  // sibling `<img class="still">` and nothing else. A rule narrowed to
  // photographs would take that away silently, leaving a model card decoding a
  // 900px still at a zoom where the card is under a hundred pixels wide.
  assert.match(css, /#world\.is-stilled \.item-body img\.still\.is-ready\s*\{\s*display:\s*block/);
  assert.match(css, /#world\.is-stilled \.item-body img:not\(\.still\):has\(\+ \.still\.is-ready\)/);
});
