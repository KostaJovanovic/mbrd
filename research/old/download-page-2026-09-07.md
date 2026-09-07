# The download page — copy, markup and the two things it must say

> **Carried out on 2026-09-07, which is why this is in `old/`.** The maintainer
> said `/download`, and the page was built from the copy below as
> `web/download.html` with `web/assets/css/download.css`. What was decided
> rather than copied:
>
> - **It is `privacy.html`'s page, not `patch.html`'s.** No generator: it has no
>   markdown source, so it loads `tokens.css` plus one sheet and carries no
>   inline script or style, which keeps it out of the CSP hash list entirely —
>   the same trade `/privacy` makes. The `SHELL` question the section below
>   worried about turned out to be two lines and a fourth branch in the navigate
>   handler.
> - **The `<details>` is gone**, and the warning is a plate at the top of the
>   spine. Its own argument here is that the warning has to arrive *in advance*;
>   a fold puts the summary in advance and the three remedies behind a press,
>   and the remedies are the half somebody reads with a refused installer
>   already on screen.
> - **The chip detection was not written in.** `arch: universal` still holds, so
>   there is one Mac link and nothing to detect — and the script would have cost
>   the page a `sha256-` in `web/_headers` to guess at something it knows.
> - **The `RELEASE/` and `VERSION` placeholders were resolved by removing the
>   version from the filenames**, not by templating them: the three
>   `artifactName` lines in `desktop/electron-builder.yml` are now
>   `mbrd-Setup.exe`, `mbrd-universal.dmg` and `mbrd-x86_64.AppImage`, which is
>   what makes `releases/latest/download/<name>` a link nobody has to edit.
>   `tests/download.test.js` holds the config and the page in step both ways.
> - **The ffmpeg licence notice, listed below as missing, was added** — to
>   `THIRD-PARTY.md` and to the fold in the credits sheet in `index.html`.
>
> The prose below is as it was written and is the source the page was built
> from; the wording on the page is this wording. Everything under "What is still
> missing from the release itself" is done.

*Group J2 of [`electron-tasks-2026-09-06.md`](../electron-tasks-2026-09-06.md).
The task said the page goes "wherever the site's download lives (the maintainer
says)", and at the time of writing the maintainer had not said — so this was the
page's **content**, written and ready, with no route chosen for it.*

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
