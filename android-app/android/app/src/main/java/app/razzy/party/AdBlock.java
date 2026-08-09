package app.razzy.party;

import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;

/**
 * Drops requests to ad and tracking endpoints before they leave the device.
 *
 * This isn't only about not watching adverts. A pre-roll desynchronises the room
 * for everyone: one viewer sits through thirty seconds of something else while
 * the film carries on, so the room stops and waits for them. Fewer ads means
 * fewer of those.
 *
 * It is a blocklist, so it is honest about being partial — it catches the ad and
 * measurement services, which is most of what an embed pulls in. Where YouTube
 * serves an advert from the same host and path as the video itself, nothing at
 * this layer can tell the two apart, and that one gets through.
 */
public class AdBlock extends BridgeWebViewClient {

    public AdBlock(Bridge bridge) {
        super(bridge);
    }

    /** Whole hosts that exist only to serve or measure advertising. */
    private static final String[] HOSTS = {
        "doubleclick.net",
        "googleadservices.com",
        "googlesyndication.com",
        "google-analytics.com",
        "googletagservices.com",
        "googletagmanager.com",
        "adservice.google.com",
        "moatads.com",
        "scorecardresearch.com",
        "innovid.com",
        "adsafeprotected.com",
        "serving-sys.com",
    };

    /** Paths on hosts we otherwise need, so they can't be blocked wholesale. */
    private static final String[] PATHS = {
        "/pagead/",
        "/ptracking",
        "/api/stats/ads",
        "/api/stats/qoe",
        "/youtubei/v1/log_event",
        "/generate_204",
    };

    private static boolean blocked(String host, String path) {
        if (host == null) return false;
        for (String h : HOSTS) {
            if (host.equals(h) || host.endsWith("." + h)) return true;
        }
        if (path == null) return false;
        // Only on Google's own hosts: "/pagead/" is theirs, and blocking that
        // path everywhere would be someone else's site broken for no reason.
        boolean google = host.endsWith("google.com") || host.endsWith("youtube.com")
            || host.endsWith("googlevideo.com") || host.endsWith("ytimg.com");
        if (!google) return false;
        for (String p : PATHS) {
            if (path.startsWith(p)) return true;
        }
        return false;
    }

    private static WebResourceResponse nothing() {
        // 200 with an empty body rather than an error: a refused request makes
        // some players retry in a loop, and an empty one just looks like a
        // resource with nothing in it.
        return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        if (request != null && request.getUrl() != null
            && blocked(request.getUrl().getHost(), request.getUrl().getPath())) {
            return nothing();
        }
        return super.shouldInterceptRequest(view, request);
    }
}
