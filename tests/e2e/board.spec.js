// The four flows the unit suite structurally cannot see.
//
// Every case here goes through `window.mbrd`, the console handle main.js
// exposes deliberately (`mbrd.board`, `mbrd.vp`, `mbrd.cmds`). That is not a
// test back door - it is a shipped feature, and using it here means these
// assertions read the same state a person poking at the console would.
//
// What is deliberately NOT asserted: pixels. A screenshot diff of a board whose
// whole point is a hand-tuned look would fail on every palette change and teach
// everyone to ignore it. These assert behaviour - the view moved, the item
// exists, the board came back - and leave the look to eyes.

import { test, expect } from '@playwright/test';

/** The app is up once the boot cover has gone and the console handle exists. */
async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => !!window.mbrd?.vp, null, { timeout: 15_000 });
  // The splash removes itself a frame after the board is drawn.
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 10_000 });
}

test.describe('the canvas', () => {
  test('pans with a drag on empty space and zooms with the wheel', async ({ page }) => {
    await ready(page);

    const before = await page.evaluate(() => ({ ...window.mbrd.vp.pan, zoom: window.mbrd.vp.zoom }));

    // Middle-drag, which pans from anywhere - see the gesture map at the top of
    // canvas/input.js. A left-drag would be the more obvious gesture and is the
    // wrong one to write here: a fresh board opens with the title card and the
    // three hint cards around the origin, so a left-drag from the middle of the
    // viewport grabs a card and moves *it*, which is correct behaviour and not
    // what this case is about.
    const box = await page.locator('#viewport').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(box.x + box.width / 2 - 160, box.y + box.height / 2 - 90, { steps: 12 });
    await page.mouse.up({ button: 'middle' });

    const panned = await page.evaluate(() => ({ ...window.mbrd.vp.pan }));
    expect(panned.x).not.toBeCloseTo(before.x, 1);

    // Wheel zoom is to the cursor, so the zoom must change and the view with it.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(400);          // the zoom animates
    const zoomed = await page.evaluate(() => window.mbrd.vp.zoom);
    expect(zoomed).toBeGreaterThan(before.zoom);
  });

  test('a two-finger swipe pans both ways instead of zooming', async ({ page }) => {
    // A wheel event carrying a sideways delta is a touchpad - no wheel has that
    // axis - and this is the one place that can be shown for real: the deltas a
    // browser builds are the deltas readWheel() has to classify, and the unit
    // suite can only hand it an object shaped like one. It also holds the two
    // apart on the same machine, which is the whole trick: this case swipes and
    // the case above it spins a wheel, and they must not do the same thing.
    await ready(page);
    const before = await page.evaluate(
      () => ({ ...window.mbrd.vp.pan, zoom: window.mbrd.vp.zoom }));

    const box = await page.locator('#viewport').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(30, 30);

    const after = await page.evaluate(
      () => ({ ...window.mbrd.vp.pan, zoom: window.mbrd.vp.zoom }));
    expect(after.zoom).toBe(before.zoom);
    expect(after.x).not.toBeCloseTo(before.x, 1);
    expect(after.y).not.toBeCloseTo(before.y, 1);
  });

  test('a note can be added, selected and deleted, and undo brings it back', async ({ page }) => {
    await ready(page);

    // By id, not by count, and that is the point of writing it this way: the
    // first thing of the user's to land on a blank board sweeps the three hint
    // cards with it (dismissGhosts, canvas/ghosts.js), so the board gets
    // *smaller* on the add. Counting would assert the scaffolding, not the note.
    // Through addNoteAt, which is the context menu's path: it puts a note down
    // where it is told and returns. cmds.addNote() asks for the words first now,
    // and a dialog is not what this case is about - see its own test below.
    const id = await page.evaluate(() => {
      window.mbrd.cmds.addNoteAt({ x: 0, y: 0 });
      return window.mbrd.board.items[window.mbrd.board.items.length - 1].id;
    });
    await expect
      .poll(() => page.evaluate(i => !!window.mbrd.board.items.find(x => x.id === i), id))
      .toBe(true);
    // And the hints are gone, which is the behaviour the count would have hidden.
    await expect
      .poll(() => page.evaluate(() => window.mbrd.board.items.some(i => i.type === 'ghost')))
      .toBe(false);

    await page.evaluate(i => window.mbrd.cmds.selectAll() || i, id);
    await page.evaluate(() => window.mbrd.cmds.deleteSelection());
    await expect
      .poll(() => page.evaluate(i => !!window.mbrd.board.items.find(x => x.id === i), id))
      .toBe(false);

    // Undo is a stack of commands, each carrying its own inverse - so the item
    // comes back with its id, not as a fresh one.
    await page.evaluate(() => window.mbrd.cmds.undo());
    await expect
      .poll(() => page.evaluate(i => !!window.mbrd.board.items.find(x => x.id === i), id))
      .toBe(true);
  });
});

test.describe('the toolbar', () => {
  test('the phone handle is on a phone and nowhere else', async ({ page }) => {
    // A cascade bug, which is the one kind of mistake this file exists for: the
    // rule taking the handle away was `#toolbar-toggle` (1,0,0) against a
    // `#toolbar button` block at (1,0,1), so `display: flex` won and the desktop
    // bar grew a plus-and-Add segment in front of a Files button wearing the
    // same plus. Nothing in the unit suite can see a losing selector; a real
    // browser resolving a real cascade is the only thing that can.
    //
    // Asserted both ways round, because "hidden everywhere" would have passed
    // just as happily and left the phone with no way to open its tools.
    await ready(page);
    await expect(page.locator('#toolbar-toggle')).toBeHidden();
    await expect(page.locator('#toolbar [data-cmd="add-files"]')).toBeVisible();

    // Under the 700px query, where the bar becomes a drawer.
    await page.setViewportSize({ width: 390, height: 780 });
    await expect(page.locator('#toolbar-toggle')).toBeVisible();
    // The tools are a tier that is shut until the handle opens it.
    await expect(page.locator('#toolbar-tools')).toBeHidden();
    await page.locator('#toolbar-toggle').click();
    await expect(page.locator('#toolbar-tools')).toBeVisible();
    await expect(page.locator('#toolbar-toggle')).toHaveAttribute('aria-expanded', 'true');
    // Desktop-only tools stay off the tier.
    await expect(page.locator('#toolbar [data-cmd="connect"]')).toBeHidden();
  });

  test('the phone tier is wider than the handle, and spends the width on words', async ({ page }) => {
    // Two halves of one decision: the tier reaches past the handle on both
    // sides, out to the edges of the foot strip, and the width it buys is spent
    // on the labels. Both are lengths a cascade resolves and nothing in the unit
    // suite can see - the labels in particular are taken away by a clip-path, so
    // they are there for Playwright and for a screen reader alike whether or not
    // the rule that draws them is winning.
    await ready(page);
    await page.setViewportSize({ width: 390, height: 780 });
    await page.locator('#toolbar-toggle').click();

    const tier = await page.locator('#toolbar-tools').boundingBox();
    const handle = await page.locator('#toolbar-toggle').boundingBox();
    expect(tier.x).toBeLessThan(handle.x);
    expect(tier.x + tier.width).toBeGreaterThan(handle.x + handle.width);

    const word = cmd => page.locator(`#toolbar [data-cmd="${cmd}"] span`).boundingBox();
    for (const cmd of ['add-files', 'add-note', 'add-swatch', 'add-link']) {
      expect((await word(cmd)).width, `${cmd} should be labelled at 390`).toBeGreaterThan(10);
    }

    // And on the narrow phones the words do not fit on, all but Files go - which
    // is the case worth asserting, because it is the one nobody develops on.
    await page.setViewportSize({ width: 320, height: 700 });
    expect((await word('add-files')).width).toBeGreaterThan(10);
    expect((await word('add-note')).width).toBeLessThan(2);
  });


  test('a note is written on the note, in front of the board', async ({ page }) => {
    // The property worth asserting is not that a dialog opens: it is that the
    // thing inside the dialog is the item. A real card, the real editor over it,
    // the real formatting bar beside it - so what lands is what was in front of
    // you rather than a copy of it. Only a browser can answer this: it is a
    // contenteditable inside a top-layer <dialog>, and the card is a live node
    // moved out of the world layer and back.
    await ready(page);

    await page.locator('#toolbar [data-cmd="add-note"]').click();
    const card = page.locator('#compose-mount .item[data-type="note"]');
    await expect(card).toBeVisible();
    // The editor is open on it, and it is the ordinary one.
    await expect(card).toHaveClass(/is-editing/);
    await expect(page.locator('#compose .note-toolbar')).toBeVisible();
    await expect(page.locator('#compose .note-count')).toBeVisible();

    // Typed, not filled: the caret is already in the sheet, which is the whole
    // claim being made here.
    await page.keyboard.type('e2e note');
    await page.locator('#compose-go').click();
    // "# " and not just the words, which is the assertion worth making: the
    // first line of a note is its heading, meta.text is the Markdown the blocks
    // flatten to, and both of those are true because this went through the block
    // model rather than through a box that returns a string.
    await expect
      .poll(() => page.evaluate(() => window.mbrd.board.items
        .some(i => i.type === 'note' && i.meta?.text === '# e2e note')))
      .toBe(true);
    // And the card went home, to the layer it came from.
    await expect(page.locator('#compose-mount .item')).toHaveCount(0);
    await expect(page.locator('#world .item[data-type="note"]')).toHaveCount(1);

    // Cancelling takes the note back, written-on or not. Nothing between the add
    // and here commits, so one step of history is exactly the add - see
    // composeNote().
    const count = await page.evaluate(() => window.mbrd.board.items.length);
    await page.locator('#toolbar [data-cmd="add-note"]').click();
    // The same wait the first note gets above, and it is not ceremony. The
    // composer opens an animation frame after the click and takes the caret in
    // the one after that; until it does, focus is still on the toolbar button
    // that was just pressed - and a space on a focused button is a click. So
    // typing "not this one" straight after the click pressed Add note twice
    // more, and the board grew two notes nobody asked for. The test was
    // measuring its own race, intermittently, and it failed as often as the
    // machine was slow.
    await expect(card).toHaveClass(/is-editing/);
    await page.keyboard.type('not this one');
    await page.locator('#compose-cancel').click();
    await expect(page.locator('#compose')).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => window.mbrd.board.items.length))
      .toBe(count);
    expect(await page.evaluate(() => window.mbrd.board.items
      .some(i => i.meta?.text?.includes('not this one')))).toBe(false);
  });

  test('the colour tool asks first, with a picker', async ({ page }) => {
    // The same bargain as the note, in the shape a colour can be asked in: it is
    // answered by pointing, so the value is set rather than typed - which is the
    // whole reason it is a colour input and not a box.
    await ready(page);

    await page.locator('#toolbar [data-cmd="add-swatch"]').click();
    await expect(page.locator('#ask-field')).toHaveAttribute('type', 'color');
    await page.locator('#ask-field').evaluate(el => { el.value = '#3366cc'; });
    await page.locator('#ask-go').click();
    await expect
      .poll(() => page.evaluate(() => window.mbrd.board.items
        .some(i => i.type === 'swatch' && i.meta?.hex === '#3366cc')))
      .toBe(true);

    // And cancelling leaves nothing behind.
    const count = await page.evaluate(() => window.mbrd.board.items.length);
    await page.locator('#toolbar [data-cmd="add-swatch"]').click();
    await page.locator('#ask-cancel').click();
    await expect(page.locator('#ask-field')).toBeHidden();
    expect(await page.evaluate(() => window.mbrd.board.items.length)).toBe(count);
  });

  test('joining two cards is two clicks, and the same two again parts them', async ({ page }) => {
    // Here rather than in the unit suite because this is the one thing about
    // connections that a headless test structurally cannot reach: the armed
    // state is a branch in canvas/input.js's pointer pipeline, and what it has
    // to do is intercept a real press on a real card before selection or a drag
    // can claim it. Everything either side of that - the step function, the
    // list, undo, the file - is covered in tests/toolbar.test.js and
    // tests/connections.test.js.
    await ready(page);

    // Two cards a long way apart, so a press lands on one and nothing else.
    const ids = await page.evaluate(() => {
      // addNoteAt() returns nothing - it opens the editor a frame later - so
      // the item is taken off the end of the board, the same way the note case
      // above does it.
      const last = () => window.mbrd.board.items[window.mbrd.board.items.length - 1];
      window.mbrd.cmds.addNoteAt({ x: -260, y: 0 });
      const a = last();
      window.mbrd.cmds.addNoteAt({ x: 260, y: 0 });
      const b = last();
      window.mbrd.bus.emit('geom', [a.id, b.id]);
      return [a.id, b.id];
    });
    // The second note left an editor open on the card it made; a caret in a
    // contenteditable would swallow the Escape this case ends with.
    await page.locator('#viewport').click({ position: { x: 12, y: 12 } });

    // Through the toolbar button, not through cmds.connect() - the wiring from
    // a data-cmd to the command surface is part of what is being checked.
    await page.locator('#toolbar [data-cmd="connect"]').click();
    await expect(page.locator('#toolbar [data-cmd="connect"]')).toHaveAttribute('aria-pressed', 'true');

    const press = async id => {
      const box = await page.locator(`.item[data-id="${id}"]`).boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    await press(ids[0]);
    // The first press picks an end and must not have selected the card.
    await expect
      .poll(() => page.evaluate(() => window.mbrd.selection.size))
      .toBe(0);
    await press(ids[1]);
    await expect
      .poll(() => page.evaluate(() => window.mbrd.board.connections.length))
      .toBe(1);

    // Still armed, which is what makes joining five things one trip up here.
    await expect(page.locator('#toolbar [data-cmd="connect"]')).toHaveAttribute('aria-pressed', 'true');

    // And the same pair again takes the line away.
    await press(ids[0]);
    await press(ids[1]);
    await expect
      .poll(() => page.evaluate(() => window.mbrd.board.connections.length))
      .toBe(0);

    // Escape is the way out of the only mode this app has.
    await page.keyboard.press('Escape');
    await expect(page.locator('#toolbar [data-cmd="connect"]')).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('the look', () => {
  test('a board colours itself at the third picture, and the menu says so', async ({ page }) => {
    // The one part of the palette that no unit test can reach: the extraction
    // needs a canvas to read pixels off, ui/appearance.js touches `document` at
    // import time and cannot be loaded in Node, and what is being asserted is a
    // <select> agreeing with the colours on screen. The gate itself is pure and
    // is tested in tests/layout-settings.test.js; this is the wiring around it.
    //
    // The modules are imported by URL rather than reached through `window.mbrd`,
    // which is not a back door either: the browser resolves each specifier to
    // the module instance the app is already running, so putAsset() here is the
    // same store an import writes to.
    await ready(page);

    const add = n => page.evaluate(async i => {
      const { putAsset } = await import('/assets/js/storage/assets.js');
      const { addItems } = await import('/assets/js/state.js');
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 8;
      const ctx = canvas.getContext('2d');
      // Three saturated pictures around one hue, which is the case the extractor
      // is built for - a board of photographs that agree with each other.
      ctx.fillStyle = ['#c8281e', '#c8641e', '#b4281e'][i];
      ctx.fillRect(0, 0, 8, 8);
      const blob = await new Promise(done => canvas.toBlob(done, 'image/png'));
      const hash = String(i + 1).repeat(64);
      putAsset(hash, blob, { mime: 'image/png', ext: 'png', name: `p${i}.png` });
      addItems([{ type: 'image', x: i * 300, y: 0, w: 200, h: 200,
        asset: { hash, embedded: true } }], 'Add picture');
    }, n);

    const palette = page.locator('#opt-palette');
    await expect(palette).toHaveValue('');

    // One photograph is not a collection, and a whole interface turning over on
    // a single dropped file is the fault the floor exists to prevent.
    await add(0);
    await add(1);
    await page.waitForTimeout(300);
    await expect(palette).toHaveValue('');
    expect(await page.evaluate(
      () => document.documentElement.style.getPropertyValue('--accent'))).toBe('');

    // And the third one is the board deciding it has a colour of its own.
    await add(2);
    await expect(palette).toHaveValue('dynamic');
    expect(await page.evaluate(
      () => document.documentElement.style.getPropertyValue('--accent'))).not.toBe('');

    // The same menu is the way back: a named palette drops every extracted
    // pigment, and there is no second control to go and find. Through the panel
    // rather than through the module, because the point of the entry is that a
    // person can reach it - so the panel is opened at the tab it lives on.
    await page.locator('#menu-btn').click();
    await page.locator('#tab-look').click();
    await palette.selectOption('');
    await expect(palette).toHaveValue('');
    expect(await page.evaluate(
      () => document.documentElement.style.getPropertyValue('--accent'))).toBe('');
  });
});

test.describe('fences', () => {
  test('a fence drawn round two cards drags them, and survives a save', async ({ page }) => {
    await ready(page);

    const ids = await page.evaluate(() => {
      const last = () => window.mbrd.board.items[window.mbrd.board.items.length - 1];
      window.mbrd.cmds.addNoteAt({ x: -160, y: 0 });
      const a = last();
      window.mbrd.cmds.addNoteAt({ x: 160, y: 0 });
      const b = last();
      window.mbrd.bus.emit('geom', [a.id, b.id]);
      return [a.id, b.id];
    });
    // The second note left an editor open on the card it made.
    await page.locator('#viewport').click({ position: { x: 12, y: 12 } });

    const fence = await page.evaluate(() => {
      window.mbrd.cmds.selectAll();
      window.mbrd.cmds.fenceSelection();
      return window.mbrd.board.items.find(i => i.type === 'fence')?.id ?? null;
    });
    expect(fence, 'the fence was made').not.toBeNull();

    // It is a real card on the board, and its label bar is the only part of it
    // that takes a press - the body lets the pointer through so that panning
    // still works inside a region. So the bar is what a drag has to find.
    await expect(page.locator(`.item[data-id="${fence}"]`)).toBeVisible();
    await expect(page.locator(`.item[data-id="${fence}"] .item-bar`)).toBeVisible();

    // The name field opens on creation; close it before driving anything else.
    await page.keyboard.press('Escape');

    const before = await page.evaluate(
      ids => ids.map(id => window.mbrd.board.items.find(i => i.id === id).x), ids);

    const bar = await page.locator(`.item[data-id="${fence}"] .item-bar`).boundingBox();
    await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
    await page.mouse.down();
    await page.mouse.move(bar.x + bar.width / 2 + 220, bar.y + bar.height / 2, { steps: 12 });
    await page.mouse.up();

    const after = await page.evaluate(
      ids => ids.map(id => window.mbrd.board.items.find(i => i.id === id).x), ids);
    expect(after[0], 'the first card came along').toBeGreaterThan(before[0]);
    expect(after[1], 'and so did the second').toBeGreaterThan(before[1]);
    // By the same amount: they were towed, not each nudged.
    expect(Math.abs((after[0] - before[0]) - (after[1] - before[1]))).toBeLessThan(1);

    // And the grouping is a property of the file, not of this session.
    await page.evaluate(() => window.mbrd.cmds.save?.());
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForFunction(() => !!window.mbrd?.vp, null, { timeout: 15_000 });

    // Asserted through meta.fence rather than through fenceOf(), which is not on
    // the console handle and should not be put there for a test. The key is what
    // actually crosses the save, and on a board reopened straight into Mobile it
    // is the only thing that knows - so it is the right thing to check.
    await expect
      .poll(() => page.evaluate(ids => {
        const it = window.mbrd.board.items.find(i => i.id === ids[0]);
        return it?.meta?.fence ?? null;
      }, ids), { timeout: 10_000 })
      .toBe(fence);
  });

  test('a rubber band offers to fence what it caught, and withdraws it', async ({ page }) => {
    // The creation gesture, and the only case in the suite that can see it: the
    // offer is a real pointer landing on a real button, and the withdrawal is a
    // distance in screen pixels that no unit test has a screen to measure.
    await ready(page);

    // Well away from the origin, so the corner the band starts in is empty board
    // rather than the title card or a hint card.
    const ids = await page.evaluate(() => {
      const last = () => window.mbrd.board.items[window.mbrd.board.items.length - 1];
      window.mbrd.cmds.addNoteAt({ x: 3000, y: 3000 });
      const a = last();
      window.mbrd.cmds.addNoteAt({ x: 3600, y: 3000 });
      const b = last();
      return [a.id, b.id];
    });
    // The second note left an editor open on the card it made.
    await page.locator('#viewport').click({ position: { x: 12, y: 12 } });
    await expect(page.locator('.item.is-editing')).toHaveCount(0);

    // Both notes on screen with room around them, so the band has empty board to
    // start and finish in. No travel time: this is not what the case is about.
    await page.evaluate(ids => {
      const items = window.mbrd.board.items.filter(i => ids.includes(i.id));
      window.mbrd.vp.fit(items, 300, 0);
    }, ids);

    const boxes = await Promise.all(ids.map(
      id => page.locator(`.item[data-id="${id}"]`).boundingBox()));
    const pad = 40;
    const x0 = Math.min(...boxes.map(b => b.x)) - pad;
    const y0 = Math.min(...boxes.map(b => b.y)) - pad;
    const x1 = Math.max(...boxes.map(b => b.x + b.width)) + pad;
    const y1 = Math.max(...boxes.map(b => b.y + b.height)) + pad;

    await page.keyboard.down('Shift');
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 12 });
    await page.mouse.up();
    await page.keyboard.up('Shift');

    const prompt = page.locator('#fence-prompt');
    await expect(prompt).toBeVisible();
    await expect(prompt).toHaveText('Fence these 2');

    // Walking away is how it is declined - no key, no click, nothing to dismiss.
    // In one hop, since the rule is where the pointer is and not how it got
    // there, and to the far corner of the *window*: a move dispatched past the
    // edge of it is delivered nowhere, so a pointer sent off into space would
    // look exactly like a withdrawal that never happened.
    const view = await page.locator('#viewport').boundingBox();
    await page.mouse.move(view.x + 20, view.y + 20);
    await expect(prompt).toHaveCount(0);
    expect(await page.evaluate(() => window.mbrd.board.items.some(i => i.type === 'fence')))
      .toBe(false);

    // And again, accepted this time.
    await page.keyboard.down('Shift');
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 12 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect(prompt).toBeVisible();
    await prompt.locator('button').click();
    // The name field opens on creation; close it before anything else runs.
    await page.keyboard.press('Escape');

    const held = await page.evaluate(ids => {
      const f = window.mbrd.board.items.find(i => i.type === 'fence');
      if (!f) return null;
      return ids.map(id => {
        const it = window.mbrd.board.items.find(i => i.id === id);
        return Math.abs(it.x - f.x) <= f.w / 2 && Math.abs(it.y - f.y) <= f.h / 2;
      });
    }, ids);
    expect(held, 'the fence opened holding both cards').toEqual([true, true]);
  });
});

test.describe('storage', () => {
  test('a board survives a refresh through IndexedDB', async ({ page }) => {
    await ready(page);

    // Something identifiable, then let the autosave land.
    const title = 'e2e-' + (await page.evaluate(() => window.mbrd.board.items.length));
    await page.evaluate(t => {
      window.mbrd.cmds.addNoteAt({ x: 0, y: 0 });
      window.mbrd.board.title = t;
      window.mbrd.bus.emit('board');
    }, title);
    const count = await page.evaluate(() => window.mbrd.board.items.length);

    // autosave() is the same call the pagehide handler makes.
    await page.evaluate(() => window.mbrd.board && window.mbrd.cmds.save?.());
    await page.waitForTimeout(500);

    await page.reload();
    await page.waitForFunction(() => !!window.mbrd?.vp, null, { timeout: 15_000 });

    await expect
      .poll(() => page.evaluate(() => window.mbrd.board.items.length), { timeout: 10_000 })
      .toBe(count);
  });
});

test.describe('the shell', () => {
  test('boots with a clean console', async ({ page }) => {
    // The one assertion that would have caught the main.js split going wrong,
    // and the reason this file exists at all: every module resolving is not the
    // same as every module running.
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));

    await ready(page);
    await page.waitForTimeout(1000);

    expect(errors, `console errors on boot:\n${errors.join('\n')}`).toEqual([]);
  });
});
