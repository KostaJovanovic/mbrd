package com.valjdakosta.mbrd;

import android.app.Activity;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import androidx.annotation.RequiresApi;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.widget.Toast;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.Logger;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Every request the page (and its service worker) makes. Desktop twin:
 * serveWeb() in desktop/protocol.ts. Installed by MbrdShell.load(), before
 * Capacitor's loadWebView(), so it sees the first navigation.
 *
 *   /__mbrd/store/<store>/<key>   a store value (MbrdStore.serve)
 *   /__mbrd/file/<token>          a file MbrdFiles handed out (MbrdFiles.serve)
 *   /_capacitor_*    404 on every host and scheme: Capacitor's file and content
 *                    routes would hand an XSS a reader for any file the app can
 *                    reach, and nothing uses them
 *   everything else  MbrdRouter picks the file, Capacitor's server reads it, and
 *                    the CSP from mbrd-csp.json goes on it unless the path is exempt
 *
 * And a renderer that dies: the activity is made again rather than the app lost.
 */
final class MbrdWebViewClient extends BridgeWebViewClient {

    private static final String TAG = "MbrdWebViewClient";

    private final Bridge bridge;
    private final MbrdRouter router;
    private final Context context;
    /** web/_headers' policy, parsed by desktop/csp.mts. Empty when not staged. */
    private final String policy;
    private final Set<String> exempt;

    MbrdWebViewClient(Bridge bridge, MbrdRouter router, Context context) {
        super(bridge);
        this.bridge = bridge;
        this.router = router;
        this.context = context.getApplicationContext();
        String value = "";
        Set<String> paths = new HashSet<>();
        try (InputStream in = context.getAssets().open("mbrd-csp.json")) {
            JSONObject json = new JSONObject(MbrdShell.readAll(in));
            value = json.getString("value");
            JSONArray list = json.getJSONArray("exempt");
            for (int i = 0; i < list.length(); i++) paths.add(list.getString(i));
        } catch (IOException | JSONException e) {
            Logger.error(TAG, "assets/mbrd-csp.json is missing or unreadable, so the app runs with no CSP. Run mobile/tools/stage-web.mjs", e);
        }
        this.policy = value;
        this.exempt = Collections.unmodifiableSet(paths);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        return intercept(request);
    }

    // ---- a renderer that died ---------------------------------------------------

    /** Two crashes this close together are a board that crashes on load. */
    private static final long CRASH_LOOP_MS = 30_000;
    private static long lastCrash = 0;
    /** Why the page reloaded by itself, read once by the next startupNotes. */
    private static String crashNote = "";

    static synchronized String takeCrashNote() {
        String note = crashNote;
        crashNote = "";
        return note;
    }

    /**
     * Without this a renderer that runs out of memory takes the whole app down.
     * The dead WebView cannot be used again, so it goes, and the activity is
     * made again around a new one: the board comes back from its file and the
     * autosave. Desktop twin: crashed() in desktop/main.ts.
     */
    // Android 8 and later. Before that a dead renderer always takes the app down.
    @RequiresApi(Build.VERSION_CODES.O)
    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        boolean oom = !detail.didCrash();
        Logger.error(TAG, "renderer gone, " + (oom ? "killed for memory" : "crashed"), null);
        Activity activity = bridge.getActivity();
        if (view.getParent() instanceof ViewGroup) ((ViewGroup) view.getParent()).removeView(view);
        view.destroy();
        if (activity == null || activity.isFinishing()) return true;
        long now = SystemClock.elapsedRealtime();
        boolean looping = lastCrash != 0 && now - lastCrash < CRASH_LOOP_MS;
        lastCrash = now;
        if (looping) {
            Toast.makeText(activity, "mbrd stopped twice in a row on this board. Its file is as it was last saved.", Toast.LENGTH_LONG).show();
            activity.finish();
            return true;
        }
        synchronized (MbrdWebViewClient.class) {
            crashNote = oom
                ? "The board ran out of memory and was reloaded. Anything after the last autosave may be missing."
                : "The board stopped unexpectedly and was reloaded. Anything after the last autosave may be missing.";
        }
        activity.recreate();
        return true;
    }

    WebResourceResponse intercept(WebResourceRequest request) {
        Uri url = request.getUrl();
        String path = url.getPath() == null ? "/" : url.getPath();

        // Before any origin branch: Capacitor's server answers these on every
        // host it serves (http://app as well as https://app, and the live
        // reload server), and a page script can fetch any of them.
        if (path.startsWith("/_capacitor_")) return status(404);

        // Live reload: the page comes from serve.py on the LAN, which routes
        // everything itself and sends no CSP. Only the shell's namespace is ours.
        String serverUrl = bridge.getServerUrl();
        if (serverUrl != null && url.toString().startsWith(serverUrl)) {
            if (path.startsWith("/__mbrd/")) return serveShell(url);
            return bridge.getLocalServer().shouldInterceptRequest(request);
        }

        boolean appOrigin =
            bridge.getScheme().equalsIgnoreCase(url.getScheme()) && bridge.getHost().equalsIgnoreCase(url.getHost());
        if (!appOrigin) return bridge.getLocalServer().shouldInterceptRequest(request);

        if (path.startsWith("/__mbrd/")) return serveShell(url);

        String file = router.route(path);
        // The desktop answers a plain 404 too, with no page and no policy.
        if (file == null) return status(404);
        Uri routed = url.buildUpon().path("/" + file).build();
        WebResourceResponse res = bridge.getLocalServer().shouldInterceptRequest(new Routed(request, routed));
        if (res == null) return null;

        String mime = MbrdRouter.mime(file);
        res.setMimeType(mime);
        if (MbrdRouter.isText(mime)) res.setEncoding("utf-8");
        // The request path, not the routed one, as the desktop compares
        // url.pathname. Exempt paths get no policy: two would be intersected.
        if (!policy.isEmpty() && !exempt.contains(path)) {
            Map<String, String> headers = new HashMap<>();
            if (res.getResponseHeaders() != null) headers.putAll(res.getResponseHeaders());
            headers.put("Content-Security-Policy", policy);
            res.setResponseHeaders(headers);
        }
        return res;
    }

    /** The shell's namespace. /__mbrd/ff/... arrives with group N. */
    private WebResourceResponse serveShell(Uri url) {
        List<String> segs = url.getPathSegments();   // decoded: [__mbrd, store, <store>, <key>]
        if (segs.size() == 4 && "store".equals(segs.get(1))) return MbrdStore.serve(segs.get(2), segs.get(3));
        if (segs.size() == 3 && "file".equals(segs.get(1))) return MbrdFiles.serve(context, segs.get(2));
        return status(404);
    }

    // ---- small responses -----------------------------------------------------

    static Map<String, String> noStore() {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        return h;
    }

    static WebResourceResponse status(int code) {
        return text(code, code == 404 ? "Not found" : reason(code));
    }

    static WebResourceResponse text(int code, String body) {
        byte[] bytes = (body == null ? "" : body).getBytes(StandardCharsets.UTF_8);
        return new WebResourceResponse("text/plain", "utf-8", code, reason(code), noStore(), new ByteArrayInputStream(bytes));
    }

    private static String reason(int code) {
        switch (code) {
            case 200:
                return "OK";
            case 400:
                return "Bad Request";
            case 403:
                return "Forbidden";
            case 404:
                return "Not Found";
            default:
                return "Error";
        }
    }

    /** The original request with another URL, handed to Capacitor's server. */
    private static final class Routed implements WebResourceRequest {

        private final WebResourceRequest base;
        private final Uri url;

        Routed(WebResourceRequest base, Uri url) {
            this.base = base;
            this.url = url;
        }

        @Override
        public Uri getUrl() {
            return url;
        }

        @Override
        public boolean isForMainFrame() {
            return base.isForMainFrame();
        }

        @Override
        public boolean isRedirect() {
            return base.isRedirect();
        }

        @Override
        public boolean hasGesture() {
            return base.hasGesture();
        }

        @Override
        public String getMethod() {
            return base.getMethod();
        }

        @Override
        public Map<String, String> getRequestHeaders() {
            Map<String, String> h = base.getRequestHeaders();
            return h != null ? h : new HashMap<>();
        }
    }
}
