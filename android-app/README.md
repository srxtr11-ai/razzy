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

## The one line that matters most

```java
settings.setMediaPlaybackRequiresUserGesture(false);
```

Android WebView refuses to start any media without a touch. Without this, every
viewer lands in the "tap to play" fallback on every video — a watch party is
told when to play by the room, not by the person holding the phone.

## Icons

Generated from the same mark as the website favicon:

```bash
python ../tools/make-android-icons.py
```

Legacy icons at five densities, plus adaptive foreground layers kept inside the
mask's safe zone — launchers crop the outer ~28% into a circle or squircle, and
art drawn to the edge gets its corners eaten.
