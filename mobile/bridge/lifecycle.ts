// The lifecycle half of the Android bridge: what the desktop's main process
// sends the page. Files from "Open with" and "Share to" (MbrdShell.deliver), the
// pause that stands in for a close, and the Back button. FileAnalyser's, over
// mbrd's plugins. The status and gesture bands follow the phone's dark mode in
// MainActivity: reporting the page's colour on every change made them flicker.

import type { HandedFile } from '../../web/assets/js/platform/electron.ts';
import { hand, type Picked } from './files.ts';
import { listen } from './native.ts';

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
