package app.razzy.party;

import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /** Whether the web layer currently wants the screen to itself. */
    private boolean immersive = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();

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
    }

    /** Everything the page is allowed to ask the platform for — which is this. */
    private class Shell {
        @JavascriptInterface
        public void setImmersive(final boolean on) {
            immersive = on;
            runOnUiThread(MainActivity.this::applyImmersive);
        }
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
