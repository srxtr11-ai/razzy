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
| Avatars | Downscaled to 128px in the browser, posted as a data URL, written to the volume. No bucket, no multipart. |
| Focus mode | Header, control bar and chat collapse out of the layout (0.5s, Apple spring curve) and the film fills the screen. Every message pops a glass card — reply inline to stay, tap the body to leave into chat. Tap the screen for the exit chip. |
| Look | Liquid glass: deep blur, multi-layer inset shadows, an aqua `::before` reflection and a pointer-tracked glare, over dark green ambient light. Chat and controls are docked panels, not floating overlays. |

## Limits worth knowing

- **Direct file links only.** PixelDrain and plain `.mp4`/`.webm` URLs. Not
  YouTube, not Netflix, nothing behind DRM or a JS player.
- **Subtitles must be burned in.** Browsers don't render subtitle tracks
  embedded in an mkv/mp4; only external `.vtt` works, which isn't built.
- **PixelDrain throttles heavily-hotlinked files.** A popular file gets slower
  for everyone; the room will auto-pause a lot when that happens.
- **Every message pops a card in focus mode**, by design. During a laugh burst
  that's a stack of three. If it grates, cap it to mentions.

## Not built (deliberately)

Voice chat, episode queue, subtitle upload, accounts, video proxying.
