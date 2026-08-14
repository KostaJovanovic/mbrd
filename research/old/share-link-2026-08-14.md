# Sharing a board as a link

> **Moved to `old/` on 2026-08-14 with nothing in it built.** It went to
> `future/` first, and that was wrong twice over. `ui-audit-2026-08-13.md` went
> to `old/` the same day with all four of its findings open, on the rule that the
> register carries the items and the document keeps the argument — and this
> document is the same shape, so it cannot take the opposite rule. And `future/`
> means *speculative, and on nobody's list*, which stops being true the moment
> something is on the list: this is **L1** in
> `research/open-work-2026-08-14.md`.
>
> Read it before proposing any way of sharing a board. Most of its value is the
> two approaches it rules out and why, and both are the kind that get proposed
> again by somebody who has not read this.

*Open. Written 2026-08-14. Nothing here is built. A plan for one feature —
sending somebody a board by sending them a URL — arrived at by ruling out the
two answers that sound right and are not. The shape that survives is: the
board goes into **the sender's own cloud account**, the app runs no
infrastructure, and the recipient opens the link without an account. Dropbox
first; Google and OneDrive behind the same seam later; iCloud never, and the
reason is not effort.*

---

## The decision, in one paragraph

A moodboard is images and video, and the assets are embedded in the `.mbrd`
rather than referenced — that is the format's deliberate property, the thing
that makes a board one file you can email. It is also what kills every
share-a-link design that tries to avoid storage: **the bytes have to rest
somewhere the recipient can fetch them from on Tuesday.** No amount of
architecture gets around that. So the only question worth asking is *whose*
storage, and the answer that keeps this app's "no server" promise intact is the
sender's own — their Dropbox, their Drive, their OneDrive. The app becomes the
thing that puts a file there and reads one back, and never the thing that holds
it.

---

## What was ruled out, and why

### Peer-to-peer

The obvious idea, and it fails on the use case rather than on the plumbing.
Three reasons, in increasing severity:

- **Two browsers cannot find each other unaided.** WebRTC needs a rendezvous
  point to exchange connection details. A link is one-way: it can carry the
  sender's half, but the recipient's half has no route back. There is no
  serverless handshake, only a handshake through somebody else's server.
- **Getting through home routers needs relays.** STUN for the easy cases, TURN
  for the rest, and TURN is a relay somebody rents. "No server" is already
  false one layer below the application.
- **The fatal one: both tabs must be open at the same moment.** A link that
  only resolves while the sender's browser is running is not a link, it is a
  session. Nobody shares a moodboard by arranging to both be at their desks.

Peer-to-peer is the right mechanism for a *different* feature — two people
looking at one board live — and even that needs a rendezvous server, and would
land on the conflict problem `old/gdrive-implementation.md` already states:
item positions are absolute, there is no CRDT, and two people dragging the same
photo has no correct answer.

### A link that carries the board inside it

Genuinely serverless, and briefly attractive: the board structure compressed
into the URL fragment, which never leaves the browser — no request, no server
log, no referrer. Every piece exists already (`packBoard()` for the structure,
`storage/zip.ts` already wraps `CompressionStream('deflate-raw')`), and it
would need no change to `web/_headers` at all.

It is dead on arrival here. It fits notes, links, stickers, fences and layout,
and it cannot fit one photograph — assets are embedded bytes, and megabytes of
base64 in a URL are truncated by mail clients and chat apps long before a
browser objects. A board without its pictures is not the board. **This is
recorded so nobody re-derives it**: the idea is sound and the app is the wrong
app for it.

### iCloud

Not "harder", not "later" — **not possible**. Apple exposes no public API that
lets a website put a file into somebody's iCloud Drive or produce a public link
to one. What Apple does offer covers an app's own private container, needs a
paid developer membership, and still cannot produce the shareable URL this
feature is entirely about. It should be removed from the list rather than left
on it as future work.

### Our own storage

Worth naming so it is rejected knowingly rather than by omission: the deploy is
already Cloudflare Workers (`wrangler.jsonc`, assets-only, no `main`). Adding
R2 and about thirty lines of Worker would give a share link with no sign-in, no
size ceiling and no third party — and it is the option most projects pick. It
is out because it makes this a service with a bill and an abuse surface, which
is a different app. The instruction on this was explicit: never run any
infrastructure.

---

## The shape that survives

Sender signs in to their own cloud account once, the board uploads **to their
storage**, the app turns it into a link, and the recipient opens that link with
no account and nothing installed. The asymmetry is the whole design and it is
worth stating plainly, because it is what makes the feature cheap:

| | sender | recipient |
| --- | --- | --- |
| signs in | yes, once per session | **never** |
| storage used | theirs | none |
| what we run | nothing | nothing |

The recipient path is an anonymous fetch of a public file. That matters beyond
convenience: for Google it is what lets the integration stay on the `drive.file`
scope — which only reaches files the app itself created, is non-sensitive, and
so avoids the annual third-party security assessment the broader scopes drag in.
An app that needed to *read* the recipient's account would need a restricted
scope and a paid review. See `old/gdrive-implementation.md`, which reached the
same conclusion for sync.

### Why Dropbox first

Simplest sign-in, simplest sharing links, and no per-tenant policy to trip
over. It is the one most likely to work on the first attempt, which is what a
first provider is for — the second and third are cheap once the seam is right,
and expensive if it is not.

Google second (largest install base, `drive.file` keeps it non-sensitive).
OneDrive third, with a caveat to carry into the work: **work and school tenants
frequently block anyone-with-the-link sharing**, so the feature will fail for
some users through no fault of the app, and needs to say so rather than error.

### The thing that works today, with no code

Save a board into the Dropbox / Drive / OneDrive folder on the desktop and
share it from there like any other file. Saving already writes a real `.mbrd`
to a real path. It is clumsy — the recipient downloads and drags it back in —
but it works right now, on all four services including iCloud, and it is the
honest thing to tell somebody who asks for this before it ships.

---

## What gets built

### Phase 1 — the seam, with one provider behind it

The provider picker the feature was asked for, the Dropbox implementation, and
the open-a-shared-link path. This is the phase that has to be got right,
because two more providers land on it.

**The picker is a menu, not a new modal.** `ui/menu.ts` renders every menu in
the app and `openAnchored()` opens a non-cursor one; a second menu
implementation is the thing CLAUDE.md forbids by name. Choosing one of three is
a menu. Providers that are not built yet are simply absent from it — the
schema's "absence, not disabling" rule — so at Phase 1 the menu has one row and
should probably not appear at all until there are two.

**The name `shareBoard` is taken, and the collision is real.**
`storage/storage.ts:348` is the OS share sheet: it packs the same archive
Export writes and hands it to `navigator.share()`. That is a genuinely
different thing — a file handed to the phone, versus a URL to a hosted copy —
and calling both "share" in the panel will confuse. Suggested split:

| | today | proposed label |
| --- | --- | --- |
| `shareBoard()` | file → OS share sheet | **Send file** |
| new | upload → link | **Share link** |

The command is one entry in `cmds` (`commands.ts`) and one row in the fold at
`ui/settings-schema.ts:335` — the "make something to send somebody" group,
which is exactly what this is. Not a second event listener, not a new section.

**The link format should be opaque and ours**, not a raw provider URL:

    https://<host>/?s=<provider>.<id>

The temptation is to accept any `https://` URL and fetch it, which would handle
every service at once with no sign-in code. It is the wrong trade *here*
specifically: it forces `connect-src` open to `https:`, and `web/_headers`
spends two hundred lines arguing that this app fetches from exactly one remote
host and that a board renders with the network off. A fixed provider table
keeps the policy a list of named hosts, which is a promise the header can
actually keep.

### Phase 2 — the viewing copy

Recommended, not required, and best decided before Phase 1 ships rather than
after. A board with video runs to hundreds of megabytes; that is slow to
upload, past Dropbox's single-request ceiling (chunked upload, more code), and
worst of all the recipient waits through the entire download before seeing
anything at all.

A **viewing copy** — downscaled images, poster frames instead of video —
changes the feature from technically-working to pleasant, and shrinks every
other problem in this document. The asset store is already content-hashed and
`optimize/` already exists, so the pieces are there. Keep "share the original"
as the second option for people who want it.

### Phase 3 — Google, then OneDrive

Same seam, no new user-facing design. Google needs the `drive.file` scope and
nothing wider. OneDrive needs the tenant-policy failure to be a sentence, not
an error.

---

## Where it lands in the tree

Written against the layering rule — `util/geometry <- state <- {import,
storage, canvas} <- ui` — and the one-way edges under `state.ts`.

| what | where | note |
| --- | --- | --- |
| provider interface + table | `storage/share/` (new) | one file per provider behind one shape |
| upload / link creation | `storage/share/dropbox.ts` | reuses `packBoard()` unchanged |
| the outgoing command | `commands.ts` + `ui/settings-schema.ts:335` | one `cmds` entry, one row in the existing fold |
| the picker | `ui/menu.ts` via `openAnchored()` | never a second menu |
| "which link is this" | `page.ts` | sibling of `openingFace()`, read lazily |
| the incoming read | `main.ts` | after the session is back, like the `#feed` read |
| progress and errors | `notify.ts` | `busy()` for the upload, `toast()` for failure |

Two of those are worth a sentence each.

**`notify.ts` is exactly right for this and it is not a coincidence.** The
providers sit under `ui/` in the graph and may not import it, and an upload is
the single most obvious thing in the app that needs to say "working" and
"failed" to a person. That is what `busy()` and `toast()` are for — a channel,
not a renderer — and it keeps every provider module loadable in a test with no
browser.

**The incoming path must not silently replace the open board.** Somebody
opening a shared link may have an hour of their own work on screen. `openFile()`
already holds the right policy and the right reasoning: nothing is replaced
until the file is actually in hand, and the question is asked at that point
rather than before. Reuse it; do not write a second confirm.

---

## What it costs, stated honestly

- **`web/_headers` gains a host, and its argument needs rewriting.**
  `connect-src` picks up the provider's API and content hosts. The line that
  says jsdelivr "is the only outbound request the app makes on its own" stops
  being true, and so does the flat claim under `img-src` that a board renders
  with the network off — a *shared* board arrives over the wire before it
  renders. It still renders offline once the bytes are in the asset store and
  become `blob:` URLs like everything else, but the sentence has to say so.
- **`tests/csp.test.js` grows a fourth thing it holds in step.** Bind the host
  list to whichever module names it, the way the jsdelivr host is bound to
  `optimize/media.ts`, so a provider added in code and not in the header fails
  in `npm test` rather than on the deploy.
- **A registered app with each provider**, free but not instant, and a
  registered origin — which means the feature cannot work from a file opened off
  the desktop, and the dev server's origin has to be registered too.
- **Sign-in expires.** Browser-only OAuth gives short-lived tokens with no safe
  way to hold a refresh token. This is precisely why *sharing* is a better first
  cloud feature than the sync in `old/gdrive-implementation.md`: an expired
  token at share time is a sign-in prompt on a deliberate button press, where at
  sync time it is a silent background failure.
- **Nothing in `tests/` covers a network.** The provider modules should be pure
  enough to test against a fake, and the upload path should be the only thing
  that is not.

---

## Open questions, for the author

1. **Viewing copy or originals** — Phase 2 above. This is the one that changes
   how the feature feels, and it is cheaper to decide now than to retrofit.
2. **Does a shared link expire?** Every provider can revoke one; the app would
   need somewhere to list what has been shared, which is a small feature of its
   own and is not in this plan.
3. **Does the recipient get a copy or a view?** This plan assumes a copy —
   they open it, it becomes their board, edits are theirs. A read-only view is
   a different feature and would collide with `frame-ancestors 'none'` and the
   deliberate absence of an embeddable mode.
4. **Does the picker remember the last provider?** One entry in
   `ui/settings-schema.ts` if so.
