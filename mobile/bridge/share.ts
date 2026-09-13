// Two things the Android WebView lacks, supplied by the bridge. navigator.share:
// the WebView has none, so text and one file go to the system share sheet
// through MbrdShell.java, the file by the byte channel and a FileProvider. And a
// download link (<a download> on a blob: or data: URL), which does nothing in a
// WebView: its bytes go to the same Save dialog a board uses. Both FileAnalyser's.

import { pageFetch, transfer } from './bytes.ts';
import * as files from './files.ts';
import { call } from './native.ts';

async function share(data: ShareData = {}): Promise<void> {
  const list = data.files ?? [];
  if (list.length > 1) throw new DOMException('mbrd shares one file at a time', 'NotAllowedError');
  const options: Record<string, string> = { title: data.title ?? '', text: data.text ?? '', url: data.url ?? '' };
  const file = list[0];
  if (file) {
    const xfer = crypto.randomUUID();
    await transfer({ target: 'stage', xfer }, file);
    Object.assign(options, { xfer, name: file.name, mime: file.type });
  }
  await call('MbrdShell', 'share', options);
}

function canShare(data?: ShareData): boolean {
  if (!data) return false;
  const count = data.files?.length ?? 0;
  return count === 1 || (count === 0 && !!(data.text || data.url || data.title));
}

export function installShare(): void {
  if (typeof navigator.share === 'function') return;
  Object.defineProperty(navigator, 'share', { configurable: true, value: share });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: canShare });
}

function isSaveLink(a: Element | null): a is HTMLAnchorElement {
  return a instanceof HTMLAnchorElement && a.hasAttribute('download') && /^(blob|data):/i.test(a.href);
}

/** A data: URL's bytes, read here: connect-src allows blob: and not data:. */
function dataBytes(href: string): ArrayBuffer {
  const comma = href.indexOf(',');
  const body = href.slice(comma + 1);
  if (/;base64$/i.test(href.slice(0, comma))) {
    const text = atob(body);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes.buffer;
  }
  return new TextEncoder().encode(decodeURIComponent(body)).buffer;
}

function saveFromLink(a: HTMLAnchorElement): void {
  const name = a.getAttribute('download') || 'download';
  // Read at once, inside the click: the page revokes a blob: URL soon after.
  const bytes = a.href.startsWith('data:')
    ? Promise.resolve(dataBytes(a.href))
    : pageFetch(a.href).then(res => res.arrayBuffer());
  bytes
    .then(async data => {
      const ref = await files.pickSave(name);
      if (ref) await files.write(ref.path, data);
    })
    .catch(err => console.warn('[mbrd] the download could not be saved', err));
}

/**
 * Two ways in. A link in the document is caught by a capture listener. A
 * detached link's click event never reaches the document, so
 * HTMLAnchorElement.prototype.click is wrapped for those.
 */
export function installDownloads(): void {
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('a[download]') : null;
    if (!isSaveLink(link)) return;
    event.preventDefault();
    saveFromLink(link);
  }, true);
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (!this.isConnected && isSaveLink(this)) {
      saveFromLink(this);
      return;
    }
    click.call(this);
  };
}
