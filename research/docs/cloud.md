# The share link

*What a share link is, what a provider has to do, and what has to be edited to
add one. A specification: this describes the app as it stands. The argument that
led here — including the two designs it rules out — is
[`../old/share-link-2026-08-14.md`](../old/share-link-2026-08-14.md), which is
still worth reading before proposing any other way of sharing a board.*

---

## What it is

A board is uploaded to **the sender's own cloud account** and a link points
there. The app runs no infrastructure and never holds the file. The asymmetry is
the whole design and is what makes the feature cheap:

| | sender | recipient |
| --- | --- | --- |
| signs in | yes, once per session | **never** |
| storage used | theirs | none |
| what we run | nothing | nothing |

The recipient path is an anonymous fetch of a public file. Google Drive is the
first and so far only provider; OneDrive is next and lands on the same seam with
no user-facing design left to do. iCloud is never — Apple exposes no public API
that lets a website put a file into somebody's iCloud Drive or produce a public
link to one, so it is out of the list rather than late in it.

**Google first rather than Dropbox**, which is a change from the plan. The plan
argued Dropbox on the grounds that it is the simplest sign-in and the likeliest
to work first time, which is what a first provider is for. That was overruled on
install base: a share link's whole value is that the person you send it to can
open it, and the first provider decides how often that is true.

## The link

    https://<host>/?s=<provider>.<id>

Opaque and ours, not a raw provider URL. The temptation is to accept any
`https://` URL and fetch it, which would handle every service at once with no
sign-in code — and it is the wrong trade *here* specifically, because it forces
`connect-src` open to `https:`. `web/_headers` spends two hundred lines arguing
that this app fetches from a named list of hosts; a fixed provider table keeps
the policy a list of names, which is a promise the header can actually keep.

- **The query, not the fragment**, unlike every other thing this app reads off
  its own URL (`#feed`, `#grips`, `#perf`, `#load`). A fragment is never sent to
  a server, which is exactly why the OAuth token comes back in one — but a share
  link is meant to survive being pasted into a chat window, a mail client and a
  document, and those rewrite and truncate fragments far more readily than query
  strings. What is in this one is a provider name and a file id that is already
  public to anyone holding the link.
- **The parameter name is `s`, and it is written in one place**: `SHARE_PARAM`
  in `page.ts`. It is read from two directions that must agree — the builder
  spells it into a URL, the boot reads it back — and a second spelling would be
  a link this app writes and cannot open, which fails at nobody's desk but the
  recipient's.
- **The first dot separates.** The provider half is checked against the table;
  the id half is opaque and is held only to `[\w-]{1,256}`. A reference naming a
  provider this build does not carry parses as `null`, not as an error: an older
  build meeting a newer link should read as *this app cannot open that*.

## The two paths

**Out** — `cmds.shareLink` in `commands/file.ts`, in this order and the order
matters:

1. `confirmEmptyExport()` — nothing to share is worth saying before anything else.
2. The provider, through `shareProvider()`.
3. `askHistory()` — the file is going to somebody else by definition.
4. **A sign-in dialog, immediately before the popup.** Every browser blocks a
   popup that is not opened from a live user gesture, and the two questions above
   spend it; the popup is opened from the press that answers *this* dialog. It is
   also the honest interface — a Google window appearing unannounced over
   somebody's board is a worse surprise than a sentence saying it is about to.
5. `packForShare()` in `storage/storage.ts` — the same `serializeBoard()` and
   `packBoard()` Export and Send file use, so a board sent as a link and the same
   board exported to disk are byte-for-byte the same file.
6. A size question if the archive is over `HEAVY_SHARE` (100 MB). See below.
7. `provider.upload()`, then the link, then the clipboard.

**In** — `openIncomingShare()` in `main.ts`, after the session is back, beside
the `#feed` read and for the same reason:

1. `openingShare()` (`page.ts`) reads the query string and imports nothing.
2. `parseShareRef()` turns the value into a reference or `null`.
3. The address is cleared with `replaceState` **before** the board arrives — a
   reload of `?s=…` would otherwise fetch and open the same board a second time
   over whatever had been done to the first copy.
4. `openSharedBoard()` fetches and hands the blob to **`openFile()`**.

That last step is the whole design of the incoming path. Somebody following a
share link may have an hour of their own work on screen, and `openFile()` already
holds the right policy: the outgoing board is filed on the shelf first, and
nothing is replaced until the file is actually in hand. A second door with its
own confirm would be a second place that policy could drift from.

## What a provider has to do

`ShareProvider` in `storage/cloud/provider.ts`: `configured()`, `signedIn()`,
`signIn()`, `upload()`, `download()`. Every method may throw, and a thrown
`Error`'s message is shown to a person — so a provider's failures have to read as
sentences rather than as status codes.

- **`signIn()` must be called from a live user gesture.** It opens a popup.
- **`download()` takes no token.** The recipient's half is an anonymous fetch of
  a public file, and that is what makes a link a link. It is also what keeps
  Google on the `drive.file` scope, which reaches only files this app created, is
  non-sensitive, and so avoids the annual third-party security assessment the
  broader scopes drag in.
- **Absence, not failure.** A provider whose identifiers were never filled in
  answers `false` to `configured()` and is simply not offered — the schema's own
  rule applied to a capability instead of to a control.

### The OAuth flow, and why it looks old-fashioned

The implicit grant, deliberately. The modern advice is the authorisation-code
flow with PKCE and it is right advice for an app that has anywhere to keep a
refresh token; this one does not, because there is no server. A refresh token
would live in the browser as a long-lived credential any script on the origin can
read. The implicit grant answers with a token that expires in about an hour and
cannot be renewed silently, which is strictly less to lose. The token is held in
memory by the provider module and written nowhere.

That expiry is also why **sharing was the right first cloud feature** and sync
was not: an expired token at share time is a sign-in prompt on a button somebody
deliberately pressed, where at sync time it is a silent background failure.

**No SDK, ever.** Google's own answer is a script from `accounts.google.com`.
Loading it would put a remote host in `script-src` — the directive `web/_headers`
argues hardest about, since a host there is a place an injected `<script>` can
come from. A hundred lines of `fetch` is much the cheaper half of that trade.

**`web/oauth.html` carries no script**, and that is three decisions in one. Once
the provider has redirected the popup there it is same-origin again, so the
opener simply reads its location — no hash in `_headers` to keep in step with a
file, no `postMessage` with a target origin to get wrong, and nothing to break
when a browser blocks script in a popup. It exists at all because every path this
site does not have is answered with `index.html`, so a redirect to a
non-existent address would boot a whole second board inside a window that is
about to close. **Its address is registered with each provider, so the file may
not be renamed** without editing every registered redirect URI to match.

## Turning it on

Nothing works until `storage/cloud/config.ts` has two strings in it, and a
checkout with neither has no Share link row at all. Its header carries the four
steps; the short version is a Google Cloud project with the Drive API enabled, a
*Web application* OAuth client whose authorised origins and redirect URIs list
every origin this app is served from (`http://localhost:6273` included, or the
feature cannot be tried locally), each redirect URI being the origin plus
`/oauth.html`, and a browser API key restricted to the same referrers.

Both identifiers are **public by construction** — the client id is in every
authorisation URL a person can read out of their own address bar, and the API key
is in every request the recipient's browser makes. What protects them is
registration, not secrecy: a copy lifted from this repository is useless from any
other host.

### The apps sign in with clients of their own

The popup above works only on the website. The desktop denies the page's
`window.open` and serves `app://`, and Android serves `https://app`, so Google
has no redirect to send either of them back to. Each app therefore signs in
outside the page, through `platform.auth.google()`, and hands the page the
same kind of token the popup would:

- **The desktop** runs the loopback flow with PKCE in the system browser
  (`desktop/google-oauth.mts`): a server on `127.0.0.1` for one answer, and the
  code traded for a token in main. It needs a *Desktop app* OAuth client, whose
  id and secret go in `GOOGLE_DESKTOP_CLIENT_ID` and
  `GOOGLE_DESKTOP_CLIENT_SECRET`. Google calls that secret not secret, since
  anybody can unpack the app, and still asks for it.
- **Android** asks Google's Authorization API (`MbrdAuth.java`), which shows
  the phone's own account sheet. It needs an *Android* OAuth client for the
  package `com.valjdakosta.mbrd` and the SHA-1 of the release key. Google finds
  that client by the signature, so there is no id to write: set
  `GOOGLE_ANDROID_CLIENT` to `true` once it exists. A debug build is signed
  with another key and needs a second Android client for that key's SHA-1.

Until then an app has no Drive rows (`canSignIn()`, `googleSignInHere()` in
`provider.ts`), and still opens a link it is sent, since the recipient needs no
sign-in. The recipient half does need the API key to answer the app, so a key
restricted by referrer has to allow the apps too, or be restricted to the Drive
API instead.

`tests/share.test.js` asserts that the committed state has *neither* filled in.
If that assertion ever stands between somebody and a working deploy, it is
inverted in the same commit that fills the file in; it is a statement about this
repository, not about the feature.

## Adding a provider

Five edits, and the fourth and fifth are the ones that fail on the deploy rather
than in the suite:

1. A module under `web/assets/js/storage/cloud/` exporting a `ShareProvider`.
2. Its id in `PROVIDER_IDS` (`provider.ts`) and the object in `PROVIDERS`
   (`cloud.ts`).
3. Its identifiers in `config.ts`, and `canShareLink()` taught about them.
4. Its API host in `connect-src` in `web/_headers`. `tests/csp.test.js` binds
   the Google host to the `API` constant in `google.ts`; a new provider wants the
   same treatment, or the general "no module names a remote host the policy does
   not allow" check is the only thing catching it.
5. Its sign-in page in `csp.test.js`'s `NOT_FETCHED`, if it is navigated to
   rather than fetched — which it will be, since that is how this flow works.

And the picker, once there are two. **A menu, never a second modal**:
`ui/menu.ts` renders every menu in the app and `openAnchored()` opens a
non-cursor one. It is one call over `PROVIDER_IDS` and no module below `ui/`
changes. With one provider there is nothing to choose, which is why there is no
picker today — a menu with one row is worse than no menu.

## What is still open

- **The viewing copy.** This ships the originals, so a board of video is slow to
  upload and — the part that is not obvious from the sending end — the recipient
  waits through the entire download before seeing anything. A downscaled copy with
  poster frames instead of video would shrink every other problem here, and the
  content-hashed asset store and `optimize/` are already the pieces. Until it
  exists, the honest substitute is `HEAVY_SHARE`: over 100 MB the app says the
  number and asks. That is not a ceiling and there is deliberately no `CeilingId`
  in `consent.ts` for it — a ceiling in this app means *larger than something a
  reader can safely allocate*, and this is only *larger than somebody would like
  to wait for*.
- **Expiry.** Every provider can revoke a link. The app has nowhere that lists
  what has been shared, which is a small feature of its own and is not built.

## A dropped upload

The upload uses Drive's resumable session, because the simple upload tops out
at 5 MB, and the session is what a drop is recovered through. A chunk that gets
no answer, or a 408, 429 or 5xx, does not end the upload: `sendChunks()` waits
(0.5 s, doubling, five tries), asks the session how many bytes it holds, and
sends on from there. Any other answer is final. A share keeps its session
against the very `Blob` it sends, so when the tries run out the dialog's
**Try again** hands the same pack back and the upload goes on where it stopped.
A sync keeps its sessions by folder and name, beside the `Blob` they began
with, and the next push resumes them. Both are held in memory only: a session
belongs to a token, and the token dies with the tab.

**Resume only the bytes the session began with.** Equal size is not equal
bytes. `board.json` is a new file on every push, and bytes spliced from two
files are a broken board, so a session is resumed only for the same `Blob`
object. An asset's `Blob` is the store's own object on every push.
`tests/upload-resume.test.js` drives the protocol against a fake session.

---

# Keeping a board in sync

*The second thing the sign-in is for, and the reason the directory is
`storage/cloud/` rather than `storage/share/`. Same account, same scope, same
host in `connect-src`, same registered application — the expensive half of this
was paid for by the share link, which is why it exists at all.*

## The layout, and why it is not a `.mbrd`

```
mbrd/                      one folder, made once
  <board id>/              one folder per synced board
    board.json             the board, minus its bytes. Small.
    <sha-256>.<ext>        one file per asset, written once and never again
```

**A re-sync uploads `board.json` and nothing else.** The asset store is already
content-addressed, so a file named by the SHA-256 of its own contents can only
ever hold one set of bytes — which makes "have I already uploaded this?" a
question the folder listing answers, with no manifest to keep in step and nothing
that can go stale. A 200 MB video goes up on the sync where it arrived and is
never touched again.

That is the whole reason this is not four lines calling the share uploader. The
share path re-uploads every photograph every time, which is right for something
that happens on a button press and ruinous for something that happens every ten
minutes.

`old/gdrive-implementation.md` worried that splitting assets out "stops a board
being one file you can email, which is currently a deliberate property of the
format". It does not: the `.mbrd` export is untouched. That was one decision read
as two — a *representation in a provider* is not the format.

`drive.file` is what makes the listing safe, and it is worth restating because it
looks like it should not work: with that scope `files.list` returns **only files
this application created**. A listing is not a search of somebody's Drive that we
then filter; it is a search that cannot see anything else. That is also why no
Picker is needed to find a board again on a second machine.

## What it is not

- **Not a merge.** Item positions are absolute and there is no CRDT, so two
  machines that both moved the same photograph have no correct answer. What this
  does is *notice* — the `modifiedTime` Drive reports against the one we last saw
  — and hand the question to a person. Last writer wins, but never silently.
- **Not a daemon.** Browser-only OAuth gives an hour-long token with no safe way
  to hold a refresh token, and a popup cannot be reopened without a user gesture,
  so a timer-driven sync would fail once an hour in a way nothing could recover
  from unattended. It hangs off the `autosaved` signal instead — which already
  answers *did a person actually change something* — and when it cannot proceed
  it **stops, latches, and says so once**. The row in the panel is how somebody
  comes back, and pressing it is the gesture a sign-in needs anyway.
- **Not a delete.** Stopping a sync leaves the Drive folder exactly where it is.
  "Stop keeping this in sync" and "delete my board out of my Drive" are two
  different sentences, and a button that quietly meant both would be the worst
  kind of data loss — the kind where the app was technically told to do it.

## The ordering that is the durability guarantee

`board.json` is written **after** every asset, always. A push that dies half way
has written some assets and left the previous `board.json` in place, so the
remote is a complete *older* board rather than a newer one with holes in it. The
orphaned assets cost storage and nothing else, and the next successful push
adopts them for free because they are named by their content.
`tests/sync.test.js` asserts the order.

## Conflicts, exactly

`BoardSync.seen` is the `modifiedTime` Drive reported for `board.json`
immediately after **we** wrote it — read back rather than guessed, because it is
Drive's clock and a local `Date.now()` would make the very next push look like
somebody else's edit. A listing that disagrees means another machine has written
since. Two cases produce one:

- the ordinary one, two machines editing the same board;
- **a board already up there that this machine has never pushed**, which is the
  second machine opening its own local copy. Overwriting silently is exactly what
  the check exists to prevent, so a first push onto an occupied folder is a
  conflict too.

`force` is what a caller passes once a person has been asked and said overwrite,
and it re-establishes the baseline — a force that did not move `seen` would
conflict forever. Nothing in the automatic path may pass it.

## Where the bookkeeping lives

One `kv` row, `cloud-sync`: board id → `{ provider, folder, file, seen, at }`.
Local to this browser **on purpose** — it is a record of this machine's
relationship with the remote, not a property of the board, so it must not travel
inside a `.mbrd`. A board file carrying somebody's Drive folder id would leak it
to everybody they ever send the board to. A second machine finds the folder by
name instead: it is named for the board id, and `drive.file` listings only ever
return this app's own files.

`pushBoard()` does not write that row — it hands one back and the caller stores
it. That is what keeps the engine testable without a browser, and it is why
`tests/sync.test.js` can assert the interesting behaviour (what is uploaded, what
is not, what counts as a conflict) against a forty-line fake store.

## The reference union, and the trap in it

`boardAssetHashes()` in `storage/mbrd.ts` answers "what does this board point
at": live items, the bin, the faces the board is set in, and the pictures the
step history names. `packBoard()` answers the same question for itself, in a loop
that also captures labels and sorts fatal misses from tolerable ones — so they
are **two implementations bound by an assertion** rather than shared code, and
`tests/mbrd.test.js` packs a board and asserts the archive's `assets/` entries
are exactly that set.

The drift this guards is quiet and one-directional: a fifth class of reference
added to the packer and not to the walk means the sync silently stops uploading a
whole category of asset, and the board comes back on the second machine with
holes in it. That is what happened when the stored versions arrived in v0.198 and
three separate reference readers had to learn about them at once.

## Still open

- **No deletes propagate.** An asset dropped from the board stays in the Drive
  folder forever. Harmless and content-addressed, but it grows.
- **One provider.** OneDrive implements `CloudStore` and appears in the picker;
  nothing else changes.

---

## What the recipient gets

A copy. They open it, it becomes their board, their edits are theirs. A read-only
*view* is a different feature and would collide with `frame-ancestors 'none'` and
the deliberate absence of an embeddable mode.
