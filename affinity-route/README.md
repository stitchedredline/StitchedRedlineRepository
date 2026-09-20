# Affinity Route

A phone app for a trash valet route: skip the doors with nothing out, and let
residents tell you which doors *do* have trash by scanning a QR tag.

Built as a plain static web app. No build step, no npm, no server bill. It
installs to an iPhone home screen and keeps working with no signal in a
stairwell.

## What it does

**Cuts the walk.** You enter your 19 buildings and their unit numbers once.
Every night the app shows one door at a time in your real walking order and
drops the doors that have nothing out. Buildings with zero stops get a big
**SKIP** badge — not entering a building at all is the biggest time save
there is.

**Three route modes**, switchable mid-shift:

| Mode | Who you visit | Use it when |
|---|---|---|
| QR only | Doors that scanned the tag | Once residents actually use the tags |
| Smart | Scans + doors that usually have trash + doors with no history | Day-to-day default |
| Sweep all | Every door | New buildings, or a night you don't trust the data |

**Learns your route.** Close out at the end of each shift and the app records
what every door did. After about a week it knows that 204 puts trash out most
nights and 311 basically never does, and Smart mode uses that. History page
shows both lists.

**Compactor batching.** Counts bags as you pick up and tells you when to break
for a run — and whether to finish the building you're in first or dump now.

**Offline first.** Everything is stored on the phone. The cloud sync is a
bonus; lose signal and nothing stops working.

## Files

```
index.html      driver screen — the thing you use on shift
out.html        what a resident sees after scanning a tag
setup.html      one-time route builder + GPS pins + backup
qr.html         printable QR tags, one per door
history.html    per-night stats and per-door hit rates
config.js       your backend URL goes here
js/route.js     routing, skip logic, prediction, GPS optimizer
js/store.js     local storage, night state, sync
backend/Code.gs Google Apps Script backend (free)
test/           node test/route.test.js
```

## Setup

### 1. Put it online (free)

Push this repo and turn on GitHub Pages (Settings → Pages → deploy from
`main`, root). The app lives at:

```
https://<your-user>.github.io/<repo>/affinity-route/
```

On the iPhone, open that, tap Share → **Add to Home Screen**. It now opens
like a normal app.

### 2. Build your route (10 minutes, once)

Open **Route setup**. Add each building in the order you actually walk it,
and paste the unit numbers — ranges work: `101-108, 110, 201-208`.

Or tap **Load sample** to try the whole app with 19 fake buildings first.

Back it up: hit **Fill with my data**, copy the text, email it to yourself.
The route lives on the phone, so that text is your only spare copy.

### 3. Turn on QR scans (10 minutes, once)

Residents need somewhere to send their tap. `backend/Code.gs` is a complete
backend that runs on a Google Sheet for free — setup steps are in the comment
at the top of that file. When you have the `/exec` URL, paste it into
`config.js` (and into Route setup on the phone).

Nothing to install for the resident, no app, no account. They scan, they tap
one button, they're done.

### 4. Print the tags

Open **Print QR tags**, enter your public address, pick a building, Build
tags, Print. Sticker paper or cardstock; one beside each door.

Do this step on wifi — the QR generator loads a library from a CDN the first
time.

## Notes

- A shift that runs past midnight counts as one night. The cutoff is 4am.
- **GPS pins are optional.** Pin the compactor and each building once, and the
  app can re-order the property by shortest walk (nearest-neighbour + 2-opt).
  Useful for setting the order the first time; after that trust your feet.
- Changing any file? Bump `CACHE` in `sw.js` or phones keep serving the old one.
- The Apps Script sheet stores unit IDs and timestamps only — no resident names,
  no phone numbers, nothing personal.

## Tests

```
node test/route.test.js
```
