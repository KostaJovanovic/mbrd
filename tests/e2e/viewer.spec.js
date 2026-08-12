// The viewer, the Feed's own surfaces, and the note composer.
//
// The second e2e file, and it exists for the reason the first one does: these
// are things a headless unit test structurally cannot see. `tests/markdown.js`
// and `tests/documents.js` cover the parsers, which are pure; what they cannot
// cover is whether the dialog opens, whether the card is drawn at the size the
// dialog reserved for it, whether the grain is on the sheet, or whether the menu
// fits on the screen. Every one of those was a real defect at some point and
// none of them is visible from Node.
//
// Same rules as board.spec.js: everything goes through `window.mbrd`, the
// console handle main.js exposes on purpose, and nothing here asserts pixels.
// The one thing that looks like a pixel assertion - the composer's ratio - is
// not: the bug it watches for drew the card at *half* the box, and the tolerance
// is wide enough that a font load moving it four points is not a failure.

import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => !!window.mbrd?.vp, null, { timeout: 15_000 });
  await expect(page.locator('#splash')).toHaveCount(0, { timeout: 10_000 });
}

/** A 1x1 PNG, as the bytes rather than a fixture on disk. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Put files on the board through the real import path.
 *
 * `importFiles` takes the point to lay the block around - the drop handler hands
 * it the cursor or the middle of the view - and `arrange()` has no centre
 * without one, so this is not a detail that can be left out.
 */
async function seed(page, spec) {
  return page.evaluate(async ({ files, png }) => {
    const bin = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const enc = new TextEncoder();
    const made = files.map(f => new File(
      [f.png ? bin : enc.encode(f.text)], f.name, f.type ? { type: f.type } : undefined));
    const { importFiles } = await import('./assets/js/import/drop.js');
    const vp = window.mbrd.vp;
    await importFiles(made, vp.toWorld(vp.left + vp.cx, vp.top + vp.cy));
    return window.mbrd.board.items.filter(i => i.meta?.ext).length;
  }, { files: spec, png: PNG_B64 });
}

const idOf = (page, ext) =>
  page.evaluate(e => window.mbrd.board.items.find(i => i.meta?.ext === e)?.id, ext);

// ---------------------------------------------------------------------------
// The viewer
// ---------------------------------------------------------------------------

test('the viewer opens a picture and closes on Escape', async ({ page }) => {
  await ready(page);
  await seed(page, [{ name: 'photo.png', png: true, type: 'image/png' }]);
  const id = await idOf(page, 'png');
  await page.evaluate(i => window.mbrd.cmds.openViewer(i), id);
  await expect(page.locator('#viewer')).toHaveAttribute('open', '');
  await expect(page.locator('#viewer-body img')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#viewer')).not.toHaveAttribute('open', '');
  // The teardown empties the body. A view left mounted is a video that keeps
  // its decoder and a document that keeps its blob URLs.
  await expect(page.locator('#viewer-body')).toBeEmpty();
});

test('Markdown is rendered, and raw HTML inside it is not', async ({ page }) => {
  await ready(page);
  await seed(page, [{
    name: 'README.md',
    type: 'text/markdown',
    text: '# Title\n\nSome **bold** and a [link](https://example.com).\n\n'
      + '- one\n  - nested\n- [x] done\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n'
      + '```js\nconst x = 1;\n```\n\n<script>alert(1)</script>\n',
  }]);
  await page.evaluate(async () => window.mbrd.cmds.openViewer(
    window.mbrd.board.items.find(i => i.meta?.ext === 'md').id));
  const md = page.locator('#viewer-body .viewer-md');
  await expect(md.locator('h1')).toHaveText('Title');
  await expect(md.locator('strong')).toHaveText('bold');
  await expect(md.locator('a')).toHaveAttribute('href', 'https://example.com/');
  await expect(md.locator('ul ul li')).toHaveText('nested');
  await expect(md.locator('li.md-task input')).toBeDisabled();
  await expect(md.locator('table th').first()).toHaveText('a');
  await expect(md.locator('pre code')).toHaveText('const x = 1;');
  // The rule the whole module is built around. The characters are there; the
  // element is not.
  await expect(md).toContainText('<script>alert(1)</script>');
  await expect(md.locator('script')).toHaveCount(0);
});

test('a Word document reads as a document', async ({ page }) => {
  await ready(page);
  const docx = await page.evaluate(async () => {
    const { writeZip } = await import('./assets/js/storage/zip.js');
    const enc = new TextEncoder();
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const blob = await writeZip([{
      name: 'word/document.xml',
      data: enc.encode(`<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>`
        + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report</w:t></w:r></w:p>'
        + '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r>'
        + '<w:r><w:rPr><w:i/></w:rPr><w:t>italic</w:t></w:r></w:p>'
        + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>top</w:t></w:r></w:p>'
        + '<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>under</w:t></w:r></w:p>'
        + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
        + '</w:body></w:document>'),
    }]);
    const { importFiles } = await import('./assets/js/import/drop.js');
    const vp = window.mbrd.vp;
    await importFiles([new File([blob], 'report.docx')],
                      vp.toWorld(vp.left + vp.cx, vp.top + vp.cy));
    const id = window.mbrd.board.items.find(i => i.meta?.ext === 'docx').id;
    window.mbrd.cmds.openViewer(id);
    return id;
  });
  expect(docx).toBeTruthy();
  const flow = page.locator('#viewer-body .doc-flow').first();
  await expect(flow.locator('h1')).toHaveText('Report');
  await expect(flow.locator('strong')).toHaveText('bold');
  await expect(flow.locator('em')).toHaveText('italic');
  await expect(flow.locator('.doc-list ul li')).toHaveText('under');
  await expect(page.locator('#viewer-body .doc-table th').first()).toHaveText('Region');
});

// ---------------------------------------------------------------------------
// The note composer
// ---------------------------------------------------------------------------

test('the composer draws the sheet at the size it reserved for it', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => window.mbrd.cmds.addNote());
  await expect(page.locator('#compose')).toHaveAttribute('open', '');
  const box = await page.evaluate(() => {
    const mount = document.getElementById('compose-mount');
    const item = mount.querySelector('.item');
    const m = mount.getBoundingClientRect();
    const i = item.getBoundingClientRect();
    return {
      ratio: i.width / m.width,
      offset: Math.abs((i.left - m.left) - (m.right - i.right)),
      inline: item.style.transform,
      computed: getComputedStyle(item).transform,
    };
  });
  // The bug: canvas/items.js writes `transform` inline, an inline declaration
  // outranks the stylesheet rule that scales the sheet, and the card was drawn
  // at life size in a box reserved at twice that - against the left edge.
  expect(box.inline).toBe('');
  expect(box.computed).toMatch(/^matrix\(2,/);
  expect(box.ratio).toBeGreaterThan(0.95);
  expect(box.ratio).toBeLessThan(1.06);
  expect(box.offset).toBeLessThanOrEqual(8);
});

// ---------------------------------------------------------------------------
// The Feed
// ---------------------------------------------------------------------------

test('the Feed shows a text file, wears the paper, and opens a tile', async ({ page }) => {
  await ready(page);
  await seed(page, [{ name: 'notes.txt', type: 'text/plain', text: 'line one\nline two\n' }]);
  await page.evaluate(() => window.mbrd.cmds.feed());
  await expect(page.locator('.feed-tile[data-kind="text"] .feed-text-body'))
    .toContainText('line one');
  // The grain. It is a pseudo-element on the sheet, joined to the shared block
  // in base.css - the Feed inherited none of it when it replaced the strip.
  const grain = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.feed-sheet'), '::before');
    return { image: cs.backgroundImage, blend: cs.mixBlendMode };
  });
  expect(grain.image).toContain('paper-grain');
  expect(grain.blend).toBe('multiply');
  // A tap on a tile opens the viewer, which is the whole point of the tap.
  await page.locator('.feed-tile[data-kind="text"]').click();
  await expect(page.locator('#viewer')).toHaveAttribute('open', '');
});

test('the Feed menu leads with Open and drops the spatial rows', async ({ page }) => {
  await ready(page);
  await seed(page, [{ name: 'photo.png', png: true, type: 'image/png' }]);
  await page.evaluate(() => window.mbrd.cmds.feed());
  await page.locator('.feed-tile').first().click({ button: 'right' });
  const rows = page.locator('[role="menu"] [role="menuitem"]');
  await expect(rows.first()).toContainText('Open');
  // Every row that is about where a card sits rather than what it is. The Feed
  // is a packed wall and throws every computed position away.
  for (const gone of ['Bring to front', 'Send to back', 'Zoom to', 'Reset size', 'note here']) {
    await expect(page.locator(`[role="menu"] [role="menuitem"]:has-text("${gone}")`))
      .toHaveCount(0);
  }
});

test('the pen comes down once the masthead has scrolled away', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await seed(page, Array.from({ length: 14 }, (_, n) =>
    ({ name: `fill${n}.png`, png: true, type: 'image/png' })));
  await page.evaluate(() => {
    const on = window.mbrd.board.layoutMode === 'mobile'
      && document.documentElement.dataset.feedLens !== 'playlist';
    // cmds.feed() is a toggle - pressing the lens you are already on steps back
    // out to the canvas, which at this width is where a naive call would land.
    if (!on) window.mbrd.cmds.feed();
  });
  const pen = page.locator('#mobile-header-edit-btn');
  await expect(pen).not.toHaveAttribute('hidden', '');
  await page.evaluate(() => {
    const r = document.getElementById('mobile-feed');
    r.scrollTop = r.scrollHeight;
  });
  await expect(pen).toHaveAttribute('hidden', '');
  await page.evaluate(() => { document.getElementById('mobile-feed').scrollTop = 0; });
  await expect(pen).not.toHaveAttribute('hidden', '');
});

// ---------------------------------------------------------------------------
// The phone toolbar
// ---------------------------------------------------------------------------

test('the phone bar is Files, Note and More, and More fits on the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  const shown = page.locator('#toolbar-tools button:visible');
  await page.locator('#toolbar-toggle').click();
  await expect(shown).toHaveText(['Files', 'Note', 'More']);

  await page.locator('#toolbar [data-cmd="more-tools"]').click();
  const menu = page.locator('[role="menu"]');
  await expect(menu.locator('[role="menuitem"]')).toHaveCount(3);
  // The bar is pinned to the bottom on a phone, and the menu used to hang below
  // its button - off the screen, with the last row simply not there.
  const box = await menu.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
});

// ---------------------------------------------------------------------------
// The two layouts
// ---------------------------------------------------------------------------

test('the canvas does not inherit the column geometry', async ({ page }) => {
  await ready(page);
  await seed(page, Array.from({ length: 6 }, (_, n) =>
    ({ name: `p${n}.png`, png: true, type: 'image/png' })));
  const moved = await page.evaluate(async () => {
    const at = () => window.mbrd.board.items
      .filter(i => i.meta?.ext)
      .map(i => `${Math.round(i.x)},${Math.round(i.y)}`).join(' ');
    window.mbrd.cmds.feed();
    await new Promise(r => setTimeout(r, 600));
    const column = at();
    window.mbrd.cmds.canvas();
    await new Promise(r => setTimeout(r, 600));
    return { column, canvas: at() };
  });
  // The bug: completeLayout()'s Desktop branch fell back to the *live* item,
  // which at the moment of a switch is still fitted to the strip and packed
  // into the column - so the canvas was the phone's two columns, one under the
  // other.
  expect(moved.canvas).not.toBe(moved.column);
});

test('the hint cards are re-minted for the layout they land on', async ({ page }) => {
  await ready(page);
  const g = await page.evaluate(async () => {
    const state = await import('./assets/js/state.js');
    state.loadBoard({ title: 'Empty', items: [] });
    await new Promise(r => setTimeout(r, 400));
    const shape = () => state.board.items.filter(i => i.type === 'ghost')
      .map(i => Math.round(i.w)).join(',');
    const desk = shape();
    window.mbrd.cmds.feed();
    await new Promise(r => setTimeout(r, 700));
    const mob = shape();
    window.mbrd.cmds.canvas();
    await new Promise(r => setTimeout(r, 700));
    return { desk, mob, back: shape() };
  });
  expect(g.desk).toBeTruthy();
  // They are never saved, so they are in no layout profile and cannot be
  // completed into one - a switch used to carry the column's widths onto the
  // canvas.
  expect(g.mob).not.toBe(g.desk);
  expect(g.back).toBe(g.desk);
});
