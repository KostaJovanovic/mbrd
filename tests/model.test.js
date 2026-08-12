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

import { orbitView } from '../web/assets/js/canvas/model.ts';

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
