# Razzy for Android

A native-packaged client for the Razzy server, not a browser pointed at the
website. It shares `lib.js` and the player abstraction with the web build, and
talks to Railway over the same REST + websocket surface — but the interface is
built for a phone in one hand and a tablet on a table.

## Build it

```bash
npm install
npm run build          # web bundle -> dist/
npx cap sync android   # copy into the native project
npm run apk            # debug APK
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`.

Requires a JDK (21 works) and the Android SDK. Gradle finds the SDK through
`android/local.properties`, which is machine-specific and not committed:

```properties
sdk.dir=C:/Users/you/AppData/Local/Android/Sdk
```

Forward slashes — backslashes need double-escaping and fail confusingly.

### A release build

```bash
keytool -genkey -v -keystore razzy.keystore -alias razzy \
        -keyalg RSA -keysize 2048 -validity 10000
npm run apk:release
```

Then sign with `apksigner`. A debug APK installs fine for your own use; only
the Play Store needs a release key.

## Which server it talks to

`https://razzy.up.railway.app` by default. The lobby has a **Server** control
that points the app somewhere else — useful for testing against a laptop —
stored in localStorage and cleared by reinstalling.

Endpoints used:

| Call | Purpose |
| --- | --- |
| `GET /api/v1/health` | reachability |
| `GET /api/v1/party/:code` | does this code exist, is it full |
| `GET /api/v1/resolve?url=` | validate a link before sending it |
| `POST /api/v1/avatar` | profile picture, downscaled to 128px first |
| `WS /ws` | everything live: room state, chat, playback |

`/api/*` sends open CORS headers because a Capacitor WebView is served from
`capacitor://localhost` and is therefore always cross-origin.

## Layout

One rule decides everything, in `useLayout()`:

| Device | Chat | Film |
| --- | --- | --- |
| Phone upright | below the film, part of the layout | fixed 16:9 |
| Phone on its side (height < 480) | sheet over the film | fills the screen |
| Tablet (shortest side ≥ 600dp **and** width ≥ 840) | docked beside the film | fills its pane |

Width alone would get this wrong: a phone in landscape is *wide*, and a 10"
tablet held upright is wide too but should still stack. Shortest-side ≥ 600dp is
Android's own definition of a tablet, so it's the one used here.

## Scaling

The things that make a WebView feel like a web page, all handled:

- **`100dvh`, never `100vh`** — dvh follows the keyboard and system bars.
- **`env(safe-area-inset-*)`** on every edge, so nothing hides under a notch,
  a punch-hole or the gesture bar. `MainActivity` sets
  `LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES` and draws edge to edge.
- **48dp minimum** on everything tappable (`--tap`), 52dp on tablets.
- **16px minimum font in inputs** — anything smaller makes Android zoom the
  viewport when the field is focused, which breaks fixed layouts.
- **The keyboard does not resize the WebView.** Resizing would make the film
  jump every time someone types. Instead the composer lifts by exactly what
  `visualViewport` reports as covered.
- **`user-scalable=no`** — pinch-zooming a synced player is never wanted.
- Heavy `backdrop-filter` is dropped on devices that report `update: slow`.

## The two lines that matter most

```java
settings.setMediaPlaybackRequiresUserGesture(false);
```

Android WebView refuses to start any media without a touch. Without this, every
viewer lands in the "tap to play" fallback on every video — a watch party is
told when to play by the room, not by the person holding the phone.

```java
webView.addJavascriptInterface(new Shell(), "RazzyNative");
```

The only thing the page can ask the platform for: `setImmersive(boolean)`. The
Fullscreen API does nothing useful in a Capacitor WebView, so without this the
"Full screen" button could only collapse Razzy's own chrome and the notification
bar stayed sitting on top of the film. Immersive mode uses
`BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE`, so a swipe brings the bars back
temporarily — a hidden navigation bar can never trap anyone. Android restores
them whenever the window regains focus, so `onWindowFocusChanged` re-applies.

## Notifications, and staying alive

Android freezes a backgrounded app. For a watch party that means the socket
dies, playback drifts out of sync, and a friend's call never rings — so while
you are in a party, `KeepAliveService` holds the process in a bucket the system
won't reclaim. It carries no logic at all; everything still happens in the
WebView, and the service exists only to stop that WebView being put to sleep. It
says so in the shade, because a background service you can't see is a battery
complaint waiting to happen, and it stops the moment you leave the party.

Capacitor also pauses the WebView when the activity goes away, which stops the
timers driving playback and the socket's heartbeat, so `onPause` undoes that
while a party is running.

Notifications go through the same bridge rather than a plugin — friend requests,
messages and invites on a normal channel, calls on one that pops over whatever
you're doing, with a full-screen intent. They only fire when the app isn't the
thing you're looking at; a notification for a message already on screen is noise.

**What this cannot do:** if Android kills the app outright — swiped away, or
reclaimed after a long time in the background — nothing arrives until you open
it again. Waking a dead app needs a push service, which means Firebase, a
`google-services.json` and a project registered with Google. That is a different
piece of work, and it's the only way to get it.

## Signing

The debug key is why Android warns on every single install: it is a well-known
shared key and the app is marked debuggable, so Play Protect treats it as
something to complain about each time. `npm run apk:release` signs with a key of
our own instead, which stops the repeat warnings and — because the signature is
now stable — lets a new build install over the old one.

The key and its password live in `android/razzy.keystore` and
`android/keystore.properties`, both untracked. **Losing them means a new
signature**, and a new signature means uninstalling before the next build will
install. Back them up somewhere that isn't this machine.

Sideloading still shows a one-off "unknown app" prompt the first time. Nothing
short of publishing to the Play Store removes that one.

## Ads

`AdBlock.java` drops requests to ad and measurement hosts before they leave the
device. It isn't only about not watching adverts: a pre-roll desynchronises the
room for everyone, because one viewer sits through thirty seconds of something
else while the film carries on and the room stops to wait for them.

It's a blocklist, so it's partial by construction. Where YouTube serves an advert
from the same host and path as the video, nothing at this layer can tell them
apart.

## Shared code

`src/components/players.jsx`, `src/sfx.js` and `src/Friends.jsx` are one-line
re-exports of the website's. They used to be copies, which is precisely why a
buffering fix could land on the site and leave the app still broken — `lib.js` is
already shared across the repo root the same way.

Sharing files across the project boundary takes **two** settings, and each fails
in a way the build never mentions:

- **`resolve.dedupe` in `vite.config.js`** — those files resolve `react` against
  `web/node_modules` while everything here uses its own copy. Two Reacts in one
  bundle means the second one's hook dispatcher is null and the app dies on the
  first `useState`: blank screen, no error on the device, nothing in the launcher
  to suggest why. Add any future shared dependency to that list.
- **`@source "../../web/src"` in `theme.css`** — Tailwind only scans its own
  project, so a class used in a shared file and nowhere in this app was never
  generated. Half-styled rather than dead, which is worse: a close button written
  `w-11 h-11` came out 44px tall and 18px wide, because `h-11` happened to be
  used here and `w-11` did not.

The way to catch this without a phone is to serve the built bundle and open it:

```bash
npm run build && npx vite preview --port 8090 --host 127.0.0.1
```

It's the same code the APK ships, and a crash shows up in the console
immediately instead of as a blank rectangle on a handset.

## Icons

Generated from the same mark as the website favicon:

```bash
python ../tools/make-android-icons.py
```

Legacy icons at five densities, plus adaptive foreground layers kept inside the
mask's safe zone — launchers crop the outer ~28% into a circle or squircle, and
art drawn to the edge gets its corners eaten.
