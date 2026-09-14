package com.valjdakosta.mbrd;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.core.content.FileProvider;
import androidx.core.content.IntentCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
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
 * Its methods: startupNotes (where the boards are, when not in Documents/mbrd),
 * share (the navigator.share the WebView lacks), checkUpdates and installUpdate
 * (MbrdUpdate). Its "update" event carries what the daily check found.
 * The status and gesture bands follow the phone's dark mode, in MainActivity,
 * rather than the page. Its events: "open" (deliver(), for "Open with"
 * and "Share to") and "pause" (the flush the desktop runs before a close).
 */
@CapacitorPlugin(name = "MbrdShell")
public class MbrdShell extends Plugin {

    /** Where stage-web.mjs writes the bundle, beside public/ and not in it. */
    static final String BRIDGE_ASSET = "mbrd-bridge.js";
    /** Left in the bundle by stage-web.mjs. The boot JSON takes its place. */
    static final String BOOT_MARKER = "/*MBRD_BOOT*/{}";

    private static final Pattern MIME = Pattern.compile("^[a-z0-9.+-]+/[a-z0-9.+-]+$", Pattern.CASE_INSENSITIVE);

    @Override
    public void load() {
        Context ctx = getContext();
        // What the updater says, for the sidebar's Update row and the page's
        // toast. An offer is retained, so a page that starts listening late
        // still hears it. A passing answer is not: it answered a press.
        MbrdUpdate.onOffer((state, version, permille, note) -> {
            JSObject offer = new JSObject();
            offer.put("state", state);
            offer.put("version", version);
            offer.put("progress", permille / 1000.0);
            offer.put("note", note);
            notifyListeners("update", offer, !"said".equals(state));
        });
        MbrdBytes.clearStage(ctx);
        // What the last run shared. The app it went to has read it by now.
        MbrdRoot.deleteTree(shareDir(ctx));

        MbrdWebViewClient client = new MbrdWebViewClient(bridge, new MbrdRouter(ctx.getAssets()), ctx);
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

    // ---- startup notes --------------------------------------------------------

    /** The desktop's startupNote, for the one case a phone has: "Not now". It
     *  names the folder, as the desktop's does. */
    @PluginMethod
    public void startupNotes(PluginCall call) {
        JSObject r = new JSObject();
        r.put(
            "note",
            MbrdRoot.isPublic()
                ? ""
                : "mbrd is keeping your boards in " + MbrdRoot.boards().getPath() + ", inside the app, "
                    + "so an uninstall would remove them. Allow file access at the next start to keep them in Documents/mbrd."
        );
        call.resolve(r);
    }

    // ---- incoming files and the pause ------------------------------------------

    /** One thread: a shared board is copied before it is delivered. */
    private static final ExecutorService INCOMING = Executors.newSingleThreadExecutor();

    /**
     * "Open with" and "Share to": the files of a VIEW, SEND or SEND_MULTIPLE
     * intent (MbrdFiles.incoming), or the text of a SEND, as the "open" event.
     * Retained until the page listens, since a cold start delivers the intent
     * before main.ts has booted. True when the intent carried something.
     */
    boolean deliver(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        String text = null;
        if (Intent.ACTION_VIEW.equals(action)) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri one = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (one != null) uris.add(one);
            else text = intent.getStringExtra(Intent.EXTRA_TEXT);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            List<Uri> list = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            if (list != null) uris.addAll(list);
        } else {
            return false;
        }
        // content:// only. A file:// URI names another app's private path, and
        // Android 7 stopped those crossing between apps.
        List<Uri> content = new ArrayList<>();
        for (Uri u : uris) if (u != null && ContentResolver.SCHEME_CONTENT.equals(u.getScheme())) content.add(u);
        String shared = text != null && !text.trim().isEmpty() ? text : null;
        if (content.isEmpty() && shared == null) return false;

        Context ctx = getContext();
        String type = intent.getType();
        INCOMING.execute(() -> {
            JSArray files = new JSArray();
            for (Uri uri : content) {
                try {
                    files.put(MbrdFiles.incoming(ctx, uri, type));
                } catch (IOException | SecurityException e) {
                    Logger.warn(getLogTag(), "could not take a shared file: " + e.getMessage());
                }
            }
            if (files.length() == 0 && shared == null) return;
            JSObject payload = new JSObject();
            payload.put("files", files);
            if (shared != null) payload.put("text", shared);
            notifyListeners("open", payload, true);
        });
        return true;
    }

    /** A phone pauses where the desktop closes, and may be killed after, so the
     *  page flushes now (onClose in mobile/bridge/lifecycle.ts). Not retained: a
     *  page that is not listening yet has nothing to flush. */
    @Override
    protected void handleOnPause() {
        notifyListeners("pause", new JSObject());
    }


    // ---- updates --------------------------------------------------------------

    /** The panel's "Check for updates" row, through updates.check() in the
     *  bridge. MbrdUpdate answers on the page, through the "update" event: the
     *  Update row for a new version, a line in the page's toast otherwise. */
    @PluginMethod
    public void checkUpdates(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) MbrdUpdate.checkNow(activity);
        call.resolve();
    }

    /** The sidebar's Update row, through updates.install() in
     *  mobile/bridge/mbrd-bridge.ts. The page has saved the board first. */
    @PluginMethod
    public void installUpdate(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) MbrdUpdate.installNow(activity);
        call.resolve();
    }

    // ---- share ----------------------------------------------------------------

    private static File shareDir(Context ctx) {
        return new File(ctx.getCacheDir(), "mbrd-share");
    }

    /**
     * The system share sheet, for text and a link, or for one file the byte
     * channel staged (xfer). The file goes out through the app's FileProvider,
     * under its own name, in a folder of its own so two shares never clash.
     */
    @PluginMethod
    public void share(PluginCall call) {
        Context ctx = getContext();
        String title = call.getString("title", "");
        String text = call.getString("text", "");
        String url = call.getString("url", "");
        String body = text.isEmpty() ? url : (url.isEmpty() ? text : text + "\n" + url);
        String xfer = call.getString("xfer", "");
        Intent send = new Intent(Intent.ACTION_SEND);
        if (!xfer.isEmpty()) {
            File staged = MbrdBytes.stagedFile(ctx, xfer);
            if (staged == null || !staged.isFile()) {
                call.reject("nothing staged");
                return;
            }
            File dir = new File(shareDir(ctx), xfer);
            File out = new File(dir, MbrdNames.safeName(call.getString("name", ""), "shared file"));
            if (!dir.mkdirs() || !staged.renameTo(out)) {
                call.reject("could not prepare the file to share");
                return;
            }
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", out);
            String mime = call.getString("mime", "");
            send.setType(mime != null && MIME.matcher(mime).matches() ? mime : "application/octet-stream");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            // The chooser passes the read grant on only from the clip data.
            send.setClipData(ClipData.newRawUri(out.getName(), uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            if (!body.isEmpty()) send.putExtra(Intent.EXTRA_TEXT, body);
        } else if (!body.isEmpty()) {
            send.setType("text/plain").putExtra(Intent.EXTRA_TEXT, body);
        } else {
            call.reject("nothing to share");
            return;
        }
        if (!title.isEmpty()) send.putExtra(Intent.EXTRA_SUBJECT, title);
        Intent chooser = Intent.createChooser(send, title.isEmpty() ? null : title);
        Activity activity = getActivity();
        activity.runOnUiThread(() -> {
            try {
                activity.startActivity(chooser);
                call.resolve();
            } catch (Exception e) {
                call.reject("no app can share this");
            }
        });
    }
}
