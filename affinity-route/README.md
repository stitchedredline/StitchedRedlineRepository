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
| Smart | Everyone except doors proven reliably empty | Day-to-day default |
| Sweep all | Every door | New buildings, or a night you don't trust the data |

Smart mode only drops a door once it has been empty on at least three quarters
of the nights it was observed, with at least three nights of data. A hit-or-miss
door still gets checked — missing real trash costs a complaint, checking one
extra door costs three seconds.

## Busy nights: call out the empties

On a night when most doors *do* have trash, logging the hits is backwards —
there are far fewer misses. **Call out empties** mode flips the assumption:
every door is treated as having trash, and you only record the exceptions.

Tap the mic and say the apartment number. You can rattle off a whole hallway
in one breath — *"204, 211, 306"* — and it logs all three. Say *"next
building"* to advance, *"undo"* to take one back. It speaks the number back to
you so you know it heard right without looking at the screen, and beeps high
for a hit, low for a miss.

The number pad grid underneath does the same job with a thumb, and always
works. Use it in a dead stairwell — voice recognition needs signal.

Two things that matter:

- **Tell it which building you're in.** Unit 101 exists in all 19 buildings, so
  the app matches what you say against the current building only. Hit **Next**
  when you finish one.
- **"Next" is what marks a building walked.** Doors you never touched in a
  walked building get scored as "had trash". A building you never marked walked
  is left out of the history entirely rather than guessed at.

This is also the fastest way to make the app smart. Two weeks of calling out
empties builds enough per-door history for Smart mode to start skipping the
dead doors on its own — no QR adoption required.

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
sunday.html     busy-night mode: call out the empties by voice
out.html        what a resident sees after scanning a tag
setup.html      one-time route builder + GPS pins + backup
qr.html         printable QR tags, one per door
history.html    per-night stats and per-door hit rates
config.js       your backend URL goes here
js/route.js     routing, skip logic, prediction, GPS optimizer
js/store.js     local storage, night state, sync
js/sunday.js    voice capture, building tracking, empty logging
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
- iOS voice quirks: Safari drops the mic when the screen locks, so the app holds
  a screen wake lock while listening. If voice misbehaves in the home-screen
  app, run `sunday.html` in Safari proper instead. The number pad never depends
  on any of that.
- The Apps Script sheet stores unit IDs and timestamps only — no resident names,
  no phone numbers, nothing personal.

## Tests

```
node test/route.test.js
node test/store.test.js
```
