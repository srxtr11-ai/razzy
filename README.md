# Razzy

Everyone watches the same file at the same second, with chat over the top.

The owner pastes a PixelDrain link, the app resolves it to the direct file
(`/api/file/{id}`) and plays it in our own `<video>`. The server holds the room
clock and relays chat.

Whether the video bytes touch this server depends on the host. Razzy probes
each one: hosts that allow cross-origin playback are handed to the browser
directly and cost us nothing. PixelDrain isn't one of them — it answers any
request carrying `Sec-Fetch-Site: cross-site` with `403 hotlink_detected`, and
browsers always send that header, so those files stream through `/stream/…`
instead. Budget for the egress: one 180 MB episode × 5 viewers is ~900 MB.

## Run it

```bash
npm install
npm run build      # builds the React front-end into web/dist
npm start          # http://localhost:3000
```

Development, with hot reload (two terminals):

```bash
npm start                  # API + websocket on :3000
npm run dev                # Vite on :5173, proxies /api and /ws
```

**Windows note:** Hyper-V reserves scattered TCP ranges, and 3000 often falls
inside one — you get `EACCES` with nothing actually listening. Check with
`netsh interface ipv4 show excludedportrange protocol=tcp` and pick a free port:
`PORT=8080 npm start`. Railway supplies `PORT`, so this is local-only.

## Checks

```bash
npm test        # pure logic: codes, link parsing, drift, laggards, crown
node smoke.js   # boots the real server and runs a full party, end to end
```

`smoke.js` boots the real server and runs 34 flows end to end: create, join
request, approve, hotlink detection, the stream route, ready check → countdown →
playing, pause, straggler + skip, chat, avatars, member cap, owner drop → crown
transfer, the solo host, YouTube and file sources, quality options, co-hosts, and
the app API.

The last block is regressions, each for something that shipped broken — the
countdown recovering instead of hanging on "Starting…", the room refusing to
restart on a sliver of buffer, an owner whose player reads 0 not rewinding
everyone, a seat being released when its occupant doesn't return, joining a film
already under way without wedging the room, and the soundboard's cooldown.

To exercise multi-user behaviour by hand without a second browser profile
(two tabs on the same origin share one identity in localStorage):

```bash
node guest.js ABC Sara 8080   # joins party ABC and chats every few seconds
```

## Deploy to Railway

1. New service from this repo. Build `npm run build`, start `npm start`.
2. **Attach a volume** and mount it at `/data` — profile pictures and the
   SQLite database live there. Without it, both vanish on every redeploy.
3. Set `DATA_DIR=/data`.

`PORT` is provided by Railway. Optional: `OWNER_GRACE_MS` (default 60000).

## How it works

| Concern | Approach |
| --- | --- |
| Sync | Server holds the room clock. The owner's player is the truth and re-anchors it every second — forwards only, so a player that momentarily reads 0 can't throw the room back to the start. Everyone else leans on `playbackRate` (proportional, ±10%) and only seeks when genuinely lost, because a seek abandons everything buffered ahead. |
| Buffer | Measured in **seconds downloaded ahead of the playhead**, not `readyState` — which says "I have a frame" right up to the moment playback stalls. |
| Stragglers | Someone with under ~1s in hand for 3 seconds running stops the room; it restarts only once they have 5s back. Two thresholds, deliberately: stopping and starting at the same level makes the room oscillate. Nothing is said in chat — the room already shows who it's waiting for, and a line per transition turned a shaky connection into a wall of text. Host can skip them. |
| Start | Ready check, then everyone loads 4 seconds before the 3-2-1 runs. Waiting once here is what buys a clean start; without it five players all begin empty, all starve at once, and the first minute stutters. |
| Host away | Only the host can press play, so a room whose host has dropped is going nowhere. Rather than a frozen frame, everyone else is offered a round of Stack. |
| Soundboard | One tap plays a clip for the whole party. The server relays an id and each client plays its own local copy, so no audio crosses the wire. Rate limited to one every 1.5s per person. |
| Control | Owner drives. Anyone can pause; the room sees who. Owner overrides. |
| Entry | 3-letter code, host accepts or declines each person in chat. |
| Owner leaves | Room pauses. After the grace period the crown passes to the longest-present member, still paused. |
| Handing over | The host taps a member to make them host or remove them. Leaving as host asks who takes over first — a room with no host sits paused with nobody able to press play. The last person out ends the party. |
| Avatars | Downscaled to 128px in the browser, posted as a data URL, written to the volume. No bucket, no multipart. |
| Full screen | One control. Header, control bar and chat collapse out of the layout (0.5s, Apple spring curve) *and* the browser goes truly fullscreen, so the phone's tabs and address bar go too. Exit leaves both; so does Escape or the back gesture, via a `fullscreenchange` listener. Every message pops a glass card — reply inline to stay, tap the body to leave into chat. Tap the screen for the exit chip. |
| Stall recovery | Chrome sometimes suspends a media load and never resumes — `readyState 0`, network "loading", no socket, film frozen. From the outside that is indistinguishable from a slow connection, except a slow connection is still growing its buffer. Only when neither the playhead nor the buffer has moved for 8s does the player reload and re-seek — reloading discards every byte downloaded so far, which on a thin line means it never finishes loading anything. |
| Seats | A disconnected member stops counting against the cap after 90s and is forgotten after 3 minutes, so a room can't end up "full" of people who left. |
| Dead connections | Wifi handing over to mobile data leaves a socket that is open according to `readyState` and dead in every other sense — no close event ever arrives. Both ends treat silence as the signal: the server drops a member with no pong for 15s, the client reconnects after 10s of hearing nothing. |
| Refresh | The party code is remembered, so reloading walks straight back in under the same identity instead of dropping you at the lobby. |
| Look | Liquid glass: deep blur, multi-layer inset shadows, an aqua `::before` reflection and a pointer-tracked glare, over dark green ambient light. Chat and controls are docked panels, not floating overlays. |

## Android app

`android-app/` builds a real APK that talks to this server. It shares `lib.js`
and the player abstraction with the web client but has its own interface, with
separate layouts for a phone upright, a phone on its side, and a tablet. See
[`android-app/README.md`](android-app/README.md).

```bash
cd android-app && npm install && npm run apk
```

## Friends

Parties are disposable; people are not. A room lives for an evening, so it lives
in memory with the database as a parachute — a friend list has to survive the
browser closing, the app being reinstalled and this server being redeployed, so
all of that *is* the database.

Still no accounts and no passwords. Identity is the random id the client
generated for itself the first time it ran. `code` is the shareable half — six
letters, because a party code gets shouted across a room and dies in an hour
while this one is typed once and kept — and `key` is the private half that
reclaims the same identity on a new phone.

| Thing | How |
| --- | --- |
| Presence | Every client says `hello` the moment it connects, party or not. Without that the server didn't know a socket existed until it was in a room, so nothing could reach anyone sitting in the lobby. |
| Adding | By code. Asking someone who already asked you counts as accepting. |
| Private chat | Kept per pair, last 200 messages, and only between people who have accepted each other. |
| Seeing them | Their list shows who is online and which party they're in, so joining is one tap rather than a code read out loud. |
| Invite | A card that waits. |
| Call | The same thing, ringing, with a 45-second life. Answering walks you straight into the caller's party — **there is no audio anywhere in this**; the point is that ringing someone is a much faster way to get them watching than typing a code at them. |
| Skipping the door | Someone a *host* called or invited walks straight in. They already said yes by ringing. An ordinary member inviting a friend still puts them in the queue. |
| Challenge | A round of Stack from the private chat: one attempt each, highest tower wins. The game posts its score out of the iframe; the page outside owns the ending, because the game has no idea anyone else is playing. |
| The running score | Wins per pair, kept in the database and shown from your own point of view, so neither side has to work out which of them the row calls "a". |

Avatar files belong to the person, not to a seat in a room. They used to be
deleted the moment a membership ended, which — once identity outlived the room —
meant your own picture was deleted when you walked out of a party, and everyone
who had you as a friend saw an empty circle from then on. Nothing deletes them by
hand now; a sweep collects files nobody points at.

## The game and the soundboard

`web/public/game/` is a self-contained Three.js/Cannon.js block-stacker, offered
to everyone else when the host drops out. It runs in an iframe on purpose: it
binds `mousedown`, `touchstart` and the spacebar to `window` and appends a canvas
to `document.body`, so inlined it would swallow every tap in the app. Closing the
iframe unwinds all of it, WebGL context included.

`web/public/sfx/` holds the soundboard clips. To add one, drop the file in and
add a line to `web/src/sfx.js`. Keep them short — it's a reaction button.

Both folders are mirrored into `android-app/public/` so the app carries its own
copies rather than fetching them.

## Brand assets

`web/public/` is generated, not hand-edited. Rebuild it from the source artwork:

```bash
python tools/make-logo.py  "<banner with wordmark>.png"   # logo.png + mark.png
python tools/make-icons.py "<square mark>.png"            # favicon.ico, app icons
```

Both keep the source art but strip its backdrop: the banner sits on black, so
brightness becomes alpha; the square mark sits on grey, where brightness fails
and *green excess* keys it instead. The header mark gets a hard alpha cut — the
artwork's soft glow survives a gentle one and reads as a blurry smudge at 24px.
The accent colour in `index.css` is sampled from the logo so the two match.

## Sources

| Paste | What happens |
| --- | --- |
| YouTube (`watch?v=`, `youtu.be`, `/shorts/`, `/embed/`, `/live/`) | YouTube's own player is embedded and driven through the IFrame API. The bytes never touch this server, so it costs nothing to run. |
| PixelDrain, direct `.mp4`/`.webm` | Played in our own `<video>`, streamed through us when the host blocks hotlinking. |
| SoundCloud track or set | The public widget at `w.soundcloud.com/player`, driven through its Widget API. No key, no token, no registered application. |
| Spotify track, album, playlist or episode | The public embed, driven through Spotify's IFrame API. Also keyless — see the limits below for what that costs. |

Music players are stitched into the same room clock as everything else, with two
differences that follow from what the embeds can actually do. Neither supports a
playback rate, so drift is corrected by seeking — cheap on a three-minute track,
ruinous on a two-hour film. And neither ever holds the room up: a SoundCloud
widget ignores `seekTo` while paused and reports nothing at all until it has
played once, so a room that stopped to wait for one would wait forever, and
there is nothing a stopped widget could do with the time anyway.

Both sit behind one small player interface (`web/src/players.jsx`), so the room
clock, straggler detection, countdown and controls are written once.

## Limits worth knowing

- **YouTube's quality cannot be set from here, at all.** `setPlaybackQuality()`
  has been a no-op for years; the undocumented `vq` player var and
  `setPlaybackQualityRange()` were both measured doing nothing — the embed kept
  serving 480p when asked for 1080p *and* when asked for 144p, at a 1016×756
  player. So there is no list of levels to pick from, because it would be a list
  of buttons that quietly do nothing. The menu shows what YouTube actually chose
  (`getPlaybackQuality`, polled) and offers YouTube's own controls, whose gear
  menu is the one place a choice sticks. File sources are unaffected — those are
  real alternate links and switching between them works.
- **Spotify plays 30-second previews.** The keyless embed gives a full track only
  to a viewer already logged into Spotify in that same browser, and inside the
  Android WebView nobody is. Using the real thing needs OAuth, a registered
  application and a Premium account per viewer — which is exactly the "token and
  developer thing" this deliberately avoids. SoundCloud has no such catch and is
  the one to reach for.
- **Not every YouTube video can be embedded.** Uploaders can disable embedding,
  and age-restricted or region-locked videos will refuse to play.
- **Ads are per-viewer.** If someone gets a pre-roll they fall behind and the
  room waits for them, which is correct but can feel abrupt.
- **Nothing behind DRM.** Netflix, Disney+ and friends are impossible, not
  merely unimplemented.
- **Autoplay:** browsers refuse to start audio without a tap. Rather than
  stalling the whole room for one person, that player falls back to muted
  playback — they stay in sync and get a "Tap for sound" chip.
- **Subtitles must be burned in.** Browsers don't render subtitle tracks
  embedded in an mkv/mp4; only external `.vtt` works, which isn't built.
- **PixelDrain throttles heavily-hotlinked files.** A popular file gets slower
  for everyone; the room will auto-pause a lot when that happens.
- **Every message pops a card in focus mode**, by design. During a laugh burst
  that's a stack of three. If it grates, cap it to mentions.

## Not built (deliberately)

Voice chat, episode queue, subtitle upload, accounts, video proxying.
