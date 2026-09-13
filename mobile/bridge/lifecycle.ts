// The lifecycle half of the Android bridge: what the desktop's main process
// sends the page. Files from "Open with" and "Share to" (MbrdShell.deliver), the
// pause that stands in for a close, the Back button, and the page background
// the status and gesture bands take. FileAnalyser's, over mbrd's plugins.

import type { HandedFile } from '../../web/assets/js/platform/electron.ts';
import { hand, type Picked } from './files.ts';
import { call, listen } from './native.ts';

/** What MbrdShell.deliver() sends: files by token, or the text of a share. */
interface Delivery {
  files?: Picked[];
  text?: string;
}

/** Shared text as a file. A link becomes a Windows internet shortcut, which
 *  import/drop.ts turns into a link card. Other text stays text. */
function textFile(text: string): HandedFile {
  const url = /https?:\/\/\S+/i.exec(text)?.[0];
  const body = url ? `[InternetShortcut]\r\nURL=${url}\r\n` : text;
  return { name: url ? 'Shared link.url' : 'Shared text.txt', path: '', data: new TextEncoder().encode(body).buffer };
}

/**
 * Wired when main.ts registers. A file shared before that (a cold start) waits
 * in Capacitor: MbrdShell retains the event until a listener exists.
 */
export function onOpenFiles(fn: (files: HandedFile[]) => void): void {
  listen('MbrdShell', 'open', data => {
    // SAFETY: the object MbrdShell.deliver() builds, whose fields are read as optional.
    const delivery = (data ?? {}) as Delivery;
    void (async () => {
      const out: HandedFile[] = [];
      for (const file of delivery.files ?? []) {
        try {
          out.push(await hand(file));
        } catch (err) {
          console.warn('[mbrd] a shared file could not be read', err);
        }
      }
      if (delivery.text) out.push(textFile(delivery.text));
      if (out.length) fn(out);
    })();
  });
}

/** A phone does not close, it pauses (MbrdShell.handleOnPause), and may be
 *  killed after. So the flush the desktop runs before a close runs here. */
export function onClose(fn: () => Promise<void>): void {
  listen('MbrdShell', 'pause', () => { void fn(); });
}

let back: (() => boolean) | null = null;

export function onBack(fn: () => boolean): void {
  back = fn;
}

/** MainActivity's Back asks this first: 'handled', or 'exit' to go to the background. */
export function installBack(): void {
  Object.defineProperty(window, '__mbrdBack', {
    value: () => {
      try {
        return back?.() ? 'handled' : 'exit';
      } catch {
        return 'exit';
      }
    },
  });
}

let probe: CanvasRenderingContext2D | null = null;

/** Any CSS colour as sRGB bytes. A canvas reads hex, color-mix() and oklch()
 *  alike, where a pattern would read only rgb(). */
function srgb(color: string): [number, number, number] | null {
  if (!probe) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    probe = canvas.getContext('2d', { willReadFrequently: true });
    if (!probe) return null;
  }
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

let reported = '';

function reportBars(): void {
  const color = getComputedStyle(document.body).backgroundColor;
  if (!color || color === reported) return;
  const rgb = srgb(color);
  if (!rgb) return;
  reported = color;
  call('MbrdShell', 'bars', { r: rgb[0], g: rgb[1], b: rgb[2] }).catch(() => { reported = ''; });
}

/** The bands follow the paper: on a change of look (data-whimsy, data-palette)
 *  or of the body's style. Read again after a moment, for a colour in transition. */
export function installBars(): void {
  document.addEventListener('DOMContentLoaded', () => {
    const report = () => {
      reportBars();
      setTimeout(reportBars, 400);
    };
    report();
    const watch = new MutationObserver(report);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-whimsy', 'data-palette', 'style', 'class'] });
    watch.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
  });
}
