// The CSP and its exemptions, parsed out of web/_headers (Cloudflare's format).
// Pure: text in, policy out, no fs and no Electron. So protocol.ts (the
// desktop), mobile/tools/stage-web.mjs (Android's mbrd-csp.json) and
// tests/csp.test.js read the one policy through the one parser. `.mts` for the
// reason format.mts gives.

/** The site-wide policy, and the paths that drop it (the wasm workers). */
export interface Policy {
  value: string;
  exempt: string[];
}

/** An empty `value` means the text has no `/*` policy. The caller reports it. */
export function parsePolicy(text: string): Policy {
  let value = '';
  const exempt: string[] = [];
  let rule = '';
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    // Column zero is a path pattern; anything indented belongs to the last one.
    if (!/^\s/.test(raw)) { rule = raw.trim(); continue; }
    const line = raw.trim();
    const removal = /^!\s*Content-Security-Policy$/i.exec(line);
    if (removal) { exempt.push(rule); continue; }
    const header = /^Content-Security-Policy:\s*(.+)$/i.exec(line);
    if (header && rule === '/*') value = header[1].trim();
  }
  return { value, exempt };
}
