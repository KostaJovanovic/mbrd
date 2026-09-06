# The download page — copy, markup and the two things it must say

*Open work. Group J2 of [`electron-tasks-2026-09-06.md`](electron-tasks-2026-09-06.md).
The task says the page goes "wherever the site's download lives (the maintainer
says)", and the maintainer has not said — so this is the page's **content**,
written and ready, with no route chosen for it. Nothing in `web/` was added.*

## Why this is a document and not `web/download.html`

Adding a page to this site is more than adding a file, and the list is in
`CLAUDE.md`: a stylesheet is a `<link>` in the markup, an entry in `SHELL`
(`web/sw.js`) and an entry in `APP_CSS_ORDER` (`tests/helpers.js`), one list
written three times because document order is the cascade. A new page also
wants a line in `sitemap.xml`, and any inline `<script>` on it needs a hash in
`web/_headers` and a matching entry in `tests/csp.test.js`.

None of that is hard. All of it is a decision about the *site*, which is a
different thing from the desktop build, and the task deferred it by name. Rule 4
of the task list also puts `SHELL` on the do-not-touch list.

So: the copy is below, the chip detection is below, and placing them is one
commit by somebody who knows where the site's front door is.

---

## What the page has to say, in order of how badly it is needed

**1. Which file to press.** Three artefacts, named by what a person calls their
computer rather than by what the build system calls it.

**2. That Windows and macOS will both complain, and that this is expected.**
This is the part that decides whether the download is worth publishing at all.
An unsigned build is not a warning-free build, and a page that does not say so
in advance produces one of two outcomes: somebody thinks the app is malware, or
somebody learns to click through security warnings. Both are worse than a
paragraph.

**3. That macOS 15 changed the workaround.** The right-click → Open bypass is
gone. Every set of instructions on the internet still says to use it, so the
page has to be more current than what a search will find.

---

## The markup

Plain, and it belongs in whatever shell the site's other pages use.

```html
<section class="download">
  <h1>Get mbrd for your computer</h1>
  <p>
    The same board, on your own machine: real files, no browser limits, and it
    works with the network off.
  </p>

  <ul class="download-list">
    <li data-os="win">
      <a class="download-button" href="RELEASE/mbrd-Setup-VERSION.exe" download>
        Download for Windows
      </a>
      <span class="download-note">
        One installer. It asks whether to install properly or unpack a portable
        copy you can carry on a stick.
      </span>
    </li>
    <li data-os="mac">
      <a class="download-button" href="RELEASE/mbrd-VERSION-universal.dmg" download>
        Download for macOS
      </a>
      <span class="download-note">Intel and Apple silicon in one file.</span>
    </li>
    <li data-os="linux">
      <a class="download-button" href="RELEASE/mbrd-VERSION-x86_64.AppImage" download>
        Download for Linux
      </a>
      <span class="download-note">
        An AppImage. Make it executable and run it — no install, no package
        manager.
      </span>
    </li>
  </ul>

  <details class="download-warning">
    <summary>Your computer will say it does not recognise this app</summary>
    <p>
      It is right. These builds are not code-signed — a signing certificate is a
      yearly fee to Microsoft or Apple, and mbrd has not paid one. Nothing about
      the app changes when it is signed; what changes is that your computer
      stops asking.
    </p>

    <h2>Windows</h2>
    <p>
      SmartScreen shows a blue box saying “Windows protected your PC”. Press
      <b>More info</b>, then <b>Run anyway</b>.
    </p>

    <h2>macOS</h2>
    <p>
      The Finder says the app “is damaged and can’t be opened”. It is not
      damaged — that is the message macOS shows for an app it has no signature
      for. Open Terminal and run:
    </p>
    <pre><code>xattr -d com.apple.quarantine /Applications/mbrd.app</code></pre>
    <p>
      Then open it normally. <b>On macOS 15 and later the old right-click →
      Open trick no longer works</b>; if you would rather not use Terminal, open
      the app once, let it be refused, then go to
      <b>System Settings → Privacy &amp; Security</b> and press <b>Open
      Anyway</b> beside the message about mbrd.
    </p>

    <h2>Linux</h2>
    <p>
      Nothing complains, but an AppImage arrives without the executable bit:
      <code>chmod +x mbrd-*.AppImage</code>, then run it.
    </p>
  </details>
</section>
```

## The chip detection

**Only needed if `arch: universal` in `desktop/electron-builder.yml` had to be
abandoned** — see plan §1, which makes two DMGs the fallback if `sharp` or
`onnxruntime-node` refuse to merge. While the universal build works there is one
Mac download and nothing to detect.

If it is needed, this is the whole of it. It is a *hint*, not a gate: both links
stay on the page and one is emphasised, because `navigator` can be wrong and a
person who knows their own machine should not have to argue with a script.

```js
// Apple silicon reports itself as Intel in `navigator.platform` - Rosetta makes
// the browser lie on purpose. The renderer string is the usual tell: Apple's
// GPU is named there and Intel's Macs never had one.
function looksLikeAppleSilicon() {
  if (!/Mac/.test(navigator.platform)) return false;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    return /Apple/.test(renderer);
  } catch {
    // A browser with WebGL off, or a canvas it will not give up. Both are
    // reasons to show both links rather than to guess.
    return false;
  }
}
```

**An inline `<script>` for this needs a `sha256-` hash in `web/_headers` and a
matching entry in `tests/csp.test.js`** — the policy carries no
`'unsafe-inline'` for scripts and that is the directive `_headers` argues
hardest about. A file under `web/assets/js/` needs neither and is the cheaper
answer.

---

## What is still missing from the release itself

- **The ffmpeg licence notice.** The build is gyan.dev 7.1 `essentials` — GPL,
  no non-free codecs — and its notice belongs in the About sheet beside the
  existing ones. Group G shipped the binary and not the notice.
- **A `URL` for the release assets.** The links above are written against
  `RELEASE/` and `VERSION` as placeholders; GitHub Releases' `latest` redirect
  (`/releases/latest/download/<name>`) is the form that does not need editing on
  every release, and the artefact names are fixed in
  `desktop/electron-builder.yml`'s `artifactName` lines.
