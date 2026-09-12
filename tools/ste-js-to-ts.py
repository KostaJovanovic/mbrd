"""Rewrite stale `.js` module names to `.ts` inside comments only.

    python tools/ste-js-to-ts.py            # dry run
    python tools/ste-js-to-ts.py --apply    # rewrite files

Rewrites `X.js` → `X.ts` when X.ts exists and X.js does not. Only touches
comment text, not string literals.
"""
import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {'node_modules', '.git', 'out', 'portable', 'dist', 'vendor',
             '.next', '__pycache__'}
SOURCE_EXT = ('.ts', '.js', '.mjs', '.css')

# A module reference: an optional dotted/slashed path, then NAME.js
REF = re.compile(r'(?<![\w./-])((?:\.{1,2}/)?(?:[\w.-]+/)*)([\w.-]+)\.js(?![\w])')

# Third-party libraries whose real name ends in .js. A BARE mention means the
# library; a pathed one means our module of the same name. `import/pdf.js` is
# the repo module and gets rewritten. Plain `pdf.js` is Mozilla's viewer and
# must not be. drop.ts:27 uses both forms in one sentence.
DENY_BARE = {'pdf.js'}


def repo_files():
    out = set()
    for base, dirs, names in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for n in names:
            rel = os.path.relpath(os.path.join(base, n), ROOT)
            out.add(rel.replace(os.sep, '/'))
    return out


def build_index(files):
    """Map a bare suffix like 'canvas/items' -> True when only the .ts exists."""
    ts, js = set(), set()
    for f in files:
        if f.endswith('.ts'):
            ts.add(f[:-3])
        elif f.endswith('.js'):
            js.add(f[:-3])
    return ts, js


def resolvable(ref_dir, ref_name, ts_stems, js_stems):
    """True when `ref` names a module that is now .ts and is not still .js.

    The reference may be bare ('state'), partial ('canvas/items') or relative
    ('./timeline'). Match on a path suffix, and demand exactly one .ts hit.
    """
    if not ref_dir.strip('./') and (ref_name + '.js') in DENY_BARE:
        return False
    stem = (ref_dir + ref_name).lstrip('./')
    if not stem:
        return False
    ts_hits = [s for s in ts_stems if s == stem or s.endswith('/' + stem)]
    js_hits = [s for s in js_stems if s == stem or s.endswith('/' + stem)]
    return len(ts_hits) >= 1 and not js_hits


def comment_spans(line, in_block, ext):
    """Return the comment regions of one line, and the new block state.

    Quotes are tracked so a `//` inside a string is not read as a comment.
    """
    spans = []
    i, n = 0, len(line)
    start = 0 if in_block else None
    quote = None
    while i < n:
        c = line[i]
        if in_block:
            if c == '*' and i + 1 < n and line[i + 1] == '/':
                spans.append((start, i + 2))
                in_block = False
                start = None
                i += 2
                continue
            i += 1
            continue
        if quote:
            if c == '\\':
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in '"\'`':
            quote = c
            i += 1
            continue
        if c == '/' and i + 1 < n:
            if line[i + 1] == '/' and ext != '.css':
                spans.append((i, n))
                return spans, False
            if line[i + 1] == '*':
                in_block = True
                start = i
                i += 2
                continue
        i += 1
    if in_block:
        spans.append((start if start is not None else 0, n))
    return spans, in_block


def rewrite_file(path, ts_stems, js_stems):
    ext = os.path.splitext(path)[1]
    with open(path, encoding='utf-8', errors='replace') as fh:
        lines = fh.read().split('\n')
    hits, out, in_block = [], [], False
    for ln, line in enumerate(lines, 1):
        spans, in_block = comment_spans(line, in_block, ext)
        if not spans:
            out.append(line)
            continue
        new = line
        # walk spans right to left so earlier offsets stay valid
        for a, b in reversed(spans):
            seg = new[a:b]
            def sub(m):
                if resolvable(m.group(1), m.group(2), ts_stems, js_stems):
                    hits.append((ln, m.group(0), m.group(1) + m.group(2) + '.ts'))
                    return m.group(1) + m.group(2) + '.ts'
                return m.group(0)
            seg = REF.sub(sub, seg)
            new = new[:a] + seg + new[b:]
        out.append(new)
    return '\n'.join(out), hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--show', type=int, default=25)
    args = ap.parse_args()

    files = repo_files()
    ts_stems, js_stems = build_index(files)

    total, touched, samples, skipped = 0, [], [], {}
    for rel in sorted(files):
        if not rel.endswith(SOURCE_EXT):
            continue
        path = os.path.join(ROOT, rel)
        try:
            new, hits = rewrite_file(path, ts_stems, js_stems)
        except OSError:
            continue
        if not hits:
            continue
        total += len(hits)
        touched.append((rel, len(hits)))
        for ln, before, after in hits[:2]:
            samples.append('%s:%d  %s -> %s' % (rel, ln, before, after))
        if args.apply:
            with open(path, 'w', encoding='utf-8', newline='') as fh:
                fh.write(new)

    # what the guard refused, for review
    for rel in sorted(files):
        if not rel.endswith(SOURCE_EXT):
            continue
        try:
            text = open(os.path.join(ROOT, rel), encoding='utf-8',
                        errors='replace').read()
        except OSError:
            continue
        for m in REF.finditer(text):
            if not resolvable(m.group(1), m.group(2), ts_stems, js_stems):
                skipped[m.group(0)] = skipped.get(m.group(0), 0) + 1

    print('%s: %d rewrites across %d files' %
          ('APPLIED' if args.apply else 'DRY RUN', total, len(touched)))
    print()
    print('busiest files:')
    for rel, n in sorted(touched, key=lambda x: -x[1])[:12]:
        print('  %-52s %4d' % (rel[:52], n))
    print()
    print('sample rewrites:')
    for s in samples[:args.show]:
        print('  ' + s)
    print()
    print('left alone by the guard (a real .js exists), top 15:')
    for name, n in sorted(skipped.items(), key=lambda x: -x[1])[:15]:
        print('  %-46s %4d' % (name[:46], n))
    return 0


if __name__ == '__main__':
    sys.exit(main())
