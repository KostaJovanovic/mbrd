package com.valjdakosta.mbrd;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The shell's plugin. Desktop twin: desktop/preload.ts, which puts the bridge in
 * the page, and serveWeb() in desktop/protocol.ts, which answers its requests.
 *
 * load() runs inside Capacitor's Bridge constructor, before loadWebView(), so it
 * is the one place that can prepare the WebView before the first page:
 *  - install MbrdWebViewClient for the page and for its service worker,
 *  - register the byte channel (MbrdBytes) as window.mbrdBytes,
 *  - inject the bridge (mobile/bridge/, built by stage-web.mjs into
 *    assets/mbrd-bridge.js) at document start, for the app origin and the dev
 *    server only, with the boot object in place of its marker.
 */
@CapacitorPlugin(name = "MbrdShell")
public class MbrdShell extends Plugin {

    /** Where stage-web.mjs writes the bundle, beside public/ and not in it. */
    static final String BRIDGE_ASSET = "mbrd-bridge.js";
    /** Left in the bundle by stage-web.mjs. The boot JSON takes its place. */
    static final String BOOT_MARKER = "/*MBRD_BOOT*/{}";

    @Override
    public void load() {
        Context ctx = getContext();
        MbrdBytes.clearStage(ctx);

        MbrdWebViewClient client = new MbrdWebViewClient(bridge, new MbrdRouter(ctx.getAssets()), ctx.getAssets());
        bridge.setWebViewClient(client);
        // A worker's requests skip the WebView client. No worker registers while
        // a shell is wired, and this keeps it so for a stale one: the same
        // routing, the same 404s. capacitor.config.json turns Capacitor's own SW
        // client off (resolveServiceWorkerRequests), or loadWebView() would
        // replace this one.
        ServiceWorkerController.getInstance().setServiceWorkerClient(
            new ServiceWorkerClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                    return client.intercept(request);
                }
            }
        );

        WebView webView = bridge.getWebView();
        Set<String> origins = new HashSet<>();
        origins.add(bridge.getScheme() + "://" + bridge.getHost());
        String serverUrl = bridge.getServerUrl();
        if (serverUrl != null) {
            Uri u = Uri.parse(serverUrl);
            origins.add(u.getScheme() + "://" + u.getAuthority());
        }
        try {
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                WebViewCompat.addWebMessageListener(webView, "mbrdBytes", origins, new MbrdBytes(ctx));
            }
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                String script = bridgeScript(ctx);
                if (script != null) WebViewCompat.addDocumentStartJavaScript(webView, script, origins);
            } else {
                // minWebViewVersion 110 is above the WebView that brought this,
                // so only a phone Capacitor already warned about gets here.
                Logger.warn(getLogTag(), "This WebView cannot run a document-start script, so the page runs as the website does.");
            }
        } catch (IllegalArgumentException e) {
            Logger.error(getLogTag(), "Could not attach the bridge", e);
        }
    }

    private String bridgeScript(Context ctx) {
        String src;
        try (InputStream in = ctx.getAssets().open(BRIDGE_ASSET)) {
            src = readAll(in);
        } catch (IOException e) {
            Logger.error(getLogTag(), "assets/" + BRIDGE_ASSET + " is missing. Run mobile/tools/stage-web.mjs", e);
            return null;
        }
        if (!src.contains(BOOT_MARKER)) {
            Logger.error(getLogTag(), "assets/" + BRIDGE_ASSET + " has no boot marker. Run mobile/tools/stage-web.mjs", null);
        }
        JSONObject boot = new JSONObject();
        try {
            boot.put("version", versionName(ctx));
            boot.put("packaged", (ctx.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0);
            boot.put("arrayBuffers", WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER));
        } catch (JSONException ignored) {
            // put() throws only for a non-finite number, and none is put.
        }
        return src.replace(BOOT_MARKER, boot.toString());
    }

    private static String versionName(Context ctx) {
        try {
            String v = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName;
            return v == null ? "" : v;
        } catch (Exception e) {
            return "";
        }
    }

    static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toString(StandardCharsets.UTF_8.name());
    }
}
