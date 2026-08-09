package app.razzy.party;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

    private static final String CH_CALLS = "razzy.calls";
    private static final String CH_MESSAGES = "razzy.messages";

    /** Whether the web layer currently wants the screen to itself. */
    private boolean immersive = false;
    /** Whether it wants to survive being backgrounded (i.e. we're in a party). */
    private boolean keepAlive = false;
    private WebView web;
    /** An Answer or Decline tapped in the shade, waiting for the page to collect it. */
    private String pendingAction = null;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = getBridge().getWebView();
        WebView webView = web;
        WebSettings settings = webView.getSettings();

        channels();
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                this, new String[] { android.Manifest.permission.POST_NOTIFICATIONS }, 1);
        }

        // The single most important line in this file. Android WebView refuses to
        // start any media without a touch, which would put every viewer into the
        // "tap to play" fallback on every video. A watch-party client is told when
        // to play by the room, not by the person holding the phone.
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Buffering a film through a WebView benefits from a real cache.
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setDomStorageEnabled(true);

        // Let the layout run edge to edge; the web side pads itself back out of
        // the notch and gesture bar with env(safe-area-inset-*).
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }

        // Never dim the screen mid-film.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // Transparent system bars over our own dark background.
        getWindow().setStatusBarColor(0x00000000);
        getWindow().setNavigationBarColor(0x00000000);
        webView.setBackgroundColor(0xFF08090B);

        // The web layer has no other way to reach the window. Without this the
        // "Full screen" button could only collapse Razzy's own chrome and the
        // notification bar stayed on top of the film.
        webView.addJavascriptInterface(new Shell(), "RazzyNative");

        // Drop ad and tracking requests before they leave the device. Subclassing
        // Capacitor's own client rather than replacing it, so the local-server
        // handling it does keeps working.
        webView.setWebViewClient(new AdBlock(getBridge()));

        // Launched by tapping Answer or Decline on a call notification.
        handleAction(getIntent());
    }

    /** Everything the page is allowed to ask the platform for. */
    private class Shell {
        @JavascriptInterface
        public void setImmersive(final boolean on) {
            immersive = on;
            runOnUiThread(MainActivity.this::applyImmersive);
        }

        /** In a party: hold the process open so the socket and the film survive. */
        @JavascriptInterface
        public void setKeepAlive(final boolean on, final String code) {
            keepAlive = on;
            Intent svc = new Intent(MainActivity.this, KeepAliveService.class).putExtra("code", code);
            if (on) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(svc);
                else startService(svc);
            } else {
                stopService(svc);
            }
        }

        /**
         * A friend request, a message, an invite or a call arriving while you're
         * in another app. `urgent` puts it on a channel that pops over whatever
         * you're doing, which is what a ringing call needs and a chat line does not.
         *
         * `answer` is a call id. When it's there the notification grows Answer and
         * Decline buttons — without them a ring was only a nudge to go and open
         * the app and find the button, which is not what a ringing phone means.
         */
        @JavascriptInterface
        public void notify(final int id, final String title, final String body,
                           final boolean urgent, final String answer) {
            PendingIntent open = intent(id, null, null);
            NotificationCompat.Builder b =
                new NotificationCompat.Builder(MainActivity.this, urgent ? CH_CALLS : CH_MESSAGES)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setSmallIcon(R.mipmap.ic_launcher)
                    .setContentIntent(open)
                    .setAutoCancel(true)
                    .setPriority(urgent ? NotificationCompat.PRIORITY_MAX : NotificationCompat.PRIORITY_DEFAULT);

            if (urgent) {
                b.setCategory(NotificationCompat.CATEGORY_CALL)
                 .setOngoing(answer != null)
                 // Shows the whole thing over the lock screen on most phones.
                 .setFullScreenIntent(open, true);
            }
            if (answer != null) {
                b.addAction(0, "Decline", intent(id + 1, "decline", answer));
                b.addAction(0, "Answer", intent(id + 2, "answer", answer));
            }
            try {
                NotificationManagerCompat.from(MainActivity.this).notify(id, b.build());
            } catch (SecurityException ignored) {
                // Notifications were refused; nothing to do but carry on.
            }
        }

        @JavascriptInterface
        public void cancelNote(final int id) {
            NotificationManagerCompat.from(MainActivity.this).cancel(id);
        }

        /** "answer <callId>" or "decline <callId>", once, or empty. */
        @JavascriptInterface
        public String takeAction() {
            String p = pendingAction;
            pendingAction = null;
            return p == null ? "" : p;
        }
    }

    /**
     * Notification taps all come back through the activity rather than a
     * receiver, because answering a call means using the websocket — and the
     * websocket lives in the WebView. Bringing the app forward with the decision
     * attached is the shortest path to the one place that can act on it.
     */
    private PendingIntent intent(int id, String action, String callId) {
        Intent i = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        if (action != null) i.putExtra("razzyAction", action).putExtra("razzyCall", callId);
        return PendingIntent.getActivity(
            this, id, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleAction(intent);
    }

    /**
     * Park the choice; the page collects it.
     *
     * Pushing it in after a fixed delay was a guess about how long the web layer
     * takes to be ready, and a cold start — tapping Answer with the app closed —
     * loses that race. Parking it means the answer waits however long it needs
     * to. The nudge below is only for the case where the page is already up.
     */
    private void handleAction(Intent intent) {
        if (intent == null) return;
        String action = intent.getStringExtra("razzyAction");
        String call = intent.getStringExtra("razzyCall");
        if (action == null || call == null) return;
        intent.removeExtra("razzyAction");
        pendingAction = action + " " + call;
        if (web != null) {
            web.postDelayed(() -> web.evaluateJavascript("window.__razzyPull && window.__razzyPull()", null), 400);
        }
    }

    private void channels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel calls =
            new NotificationChannel(CH_CALLS, "Calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setDescription("A friend calling you into their party");
        NotificationChannel msgs =
            new NotificationChannel(CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_DEFAULT);
        msgs.setDescription("Friend requests, private messages and invites");
        NotificationChannel run = new NotificationChannel(
            KeepAliveService.CHANNEL, "Watching", NotificationManager.IMPORTANCE_LOW);
        run.setDescription("Shown while a party is keeping you in sync");
        nm.createNotificationChannel(calls);
        nm.createNotificationChannel(msgs);
        nm.createNotificationChannel(run);
    }

    @Override
    public void onPause() {
        super.onPause();
        // Capacitor pauses the WebView when the activity goes away, which stops
        // the timers driving playback and the socket's own heartbeat. While a
        // party is running that's exactly what must not happen.
        if (keepAlive && web != null) {
            web.onResume();
            web.resumeTimers();
        }
    }

    @Override
    public void onDestroy() {
        stopService(new Intent(this, KeepAliveService.class));
        super.onDestroy();
    }

    private void applyImmersive() {
        WindowInsetsControllerCompat bars =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        // Swipe from an edge brings the bars back temporarily and they slide away
        // again on their own — the behaviour people expect from a video player,
        // and it means a hidden navigation bar can never trap anyone.
        bars.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        if (immersive) bars.hide(WindowInsetsCompat.Type.systemBars());
        else bars.show(WindowInsetsCompat.Type.systemBars());
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Android restores the system bars whenever the window regains focus, so
        // coming back from the recents switcher has to re-apply the choice.
        if (hasFocus) applyImmersive();
    }
}
