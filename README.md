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

`smoke.js` covers 14 flows: create, join request, approve, hotlink detection,
the stream route, ready check → countdown → playing, pause, straggler + skip,
chat, avatars, member cap, owner drop → crown transfer, and the solo host.

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
| Sync | Server holds the room clock. Owner's player is the truth and re-anchors it every second; everyone else nudges `playbackRate` for small drift and seeks past 1.5s. |
| Stragglers | Anyone buffering or >5s behind auto-pauses the room. Owner can skip them. |
| Start | Ready check, then a 3-2-1 that silently waits on everyone's buffer. |
| Control | Owner drives. Anyone can pause; the room sees who. Owner overrides. |
| Entry | 3-letter code, host accepts or declines each person in chat. |
| Owner leaves | Room pauses. After the grace period the crown passes to the longest-present member, still paused. |
| Handing over | The host taps a member to make them host or remove them. Leaving as host asks who takes over first — a room with no host sits paused with nobody able to press play. The last person out ends the party. |
| Avatars | Downscaled to 128px in the browser, posted as a data URL, written to the volume. No bucket, no multipart. |
| Full screen | One control. Header, control bar and chat collapse out of the layout (0.5s, Apple spring curve) *and* the browser goes truly fullscreen, so the phone's tabs and address bar go too. Exit leaves both; so does Escape or the back gesture, via a `fullscreenchange` listener. Every message pops a glass card — reply inline to stay, tap the body to leave into chat. Tap the screen for the exit chip. |
| Stall recovery | Chrome sometimes suspends a media load and never resumes — `readyState 0`, network "loading", no socket, film frozen. If the room is playing and the local clock hasn't moved for 4s, the player reloads and re-seeks to the room position. |
| Refresh | The party code is remembered, so reloading walks straight back in under the same identity instead of dropping you at the lobby. |
| Look | Liquid glass: deep blur, multi-layer inset shadows, an aqua `::before` reflection and a pointer-tracked glare, over dark green ambient light. Chat and controls are docked panels, not floating overlays. |

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

Both sit behind one small player interface (`web/src/players.jsx`), so the room
clock, straggler detection, countdown and controls are written once.

## Limits worth knowing

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
