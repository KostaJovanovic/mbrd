package com.valjdakosta.mbrd;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.WebView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The byte channel, page to native: window.mbrdBytes in the page. Desktop twin:
 * the structured-clone IPC under desktop/preload.ts, which Electron does for
 * free. FileAnalyser's AnrBytes, with mbrd's targets.
 *
 * Capacitor's own bridge is JSON, so bytes would cross it as base64: a third
 * larger, with several copies alive at once. This is a WebMessageListener, which
 * takes ArrayBuffer messages where the WebView has WEB_MESSAGE_ARRAY_BUFFER and
 * base64 chunks of bounded size where it does not.
 *
 * Protocol (the page half is transfer() in mobile/bridge/bytes.ts):
 *   {"op":"begin","target":"store","store":..,"key":..,"size":N}  a store value
 *   {"op":"begin","target":"file","path":..,"size":N}             a board, Save
 *   {"op":"begin","target":"stage","xfer":..,"size":N}            for a share
 *   {"op":"begin","target":"ff",..}                                group N
 *   ArrayBuffer | {"op":"chunk","b64":..}                         repeated
 *   {"op":"end"} | {"op":"abort"}
 * Every message gets exactly one JSON ack, in order: {"ok":true} or
 * {"ok":false,"error":..}. The page waits for each ack before the next send, so
 * one chunk at most is in flight. Only the app origin (and the dev server) can
 * post: MbrdShell registers the listener with those origins. A store value and a
 * board go to a temp name and are renamed at the end, so a cut transfer never
 * replaces a whole file. MbrdStore and MbrdFiles check every name and path.
 */
final class MbrdBytes implements WebViewCompat.WebMessageListener {

    static final Pattern XFER = Pattern.compile("^[A-Za-z0-9-]{1,64}$");
    private static final String OK = "{\"ok\":true}";

    private final Context context;
    // One writer thread: messages are applied in the order they arrived, and
    // disk writes stay off the UI thread onPostMessage runs on.
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private OutputStream out;
    /** What the bytes go into. */
    private File target;
    /** What `target` is renamed to at the end, or null to keep it where it is. */
    private File dest;
    private long expected;
    private long written;

    MbrdBytes(Context context) {
        this.context = context.getApplicationContext();
    }

    static File stageDir(Context context) {
        File dir = new File(context.getCacheDir(), "mbrd-stage");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    static File stagedFile(Context context, String xfer) {
        if (xfer == null || !XFER.matcher(xfer).matches()) return null;
        return new File(stageDir(context), xfer);
    }

    /** Leftovers from a run that died mid-transfer. */
    static void clearStage(Context context) {
        File[] old = stageDir(context).listFiles();
        if (old != null) for (File f : old) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    @Override
    public void onPostMessage(
        WebView view,
        WebMessageCompat message,
        Uri sourceOrigin,
        boolean isMainFrame,
        JavaScriptReplyProxy reply
    ) {
        if (!isMainFrame) return;
        final byte[] bytes;
        final String text;
        if (message.getType() == WebMessageCompat.TYPE_ARRAY_BUFFER) {
            bytes = message.getArrayBuffer();
            text = null;
        } else {
            bytes = null;
            text = message.getData();
        }
        io.execute(() -> {
            String ack;
            try {
                handle(text, bytes);
                ack = OK;
            } catch (Exception e) {
                reset(true);
                ack = error(e.getMessage());
            }
            final String result = ack;
            main.post(() -> reply.postMessage(result));
        });
    }

    private void handle(String text, byte[] bytes) throws IOException, JSONException {
        if (bytes != null) {
            write(bytes);
            return;
        }
        JSONObject m = new JSONObject(text == null ? "{}" : text);
        switch (m.optString("op")) {
            case "begin":
                reset(true);
                begin(m);
                return;
            case "chunk":
                write(Base64.decode(m.getString("b64"), Base64.DEFAULT));
                return;
            case "end":
                if (out == null) throw new IOException("no transfer open");
                out.close();
                out = null;
                if (expected >= 0 && written != expected) {
                    throw new IOException("transfer was short: " + written + " of " + expected + " bytes");
                }
                if (dest != null && !target.renameTo(dest)) throw new IOException("could not write " + dest.getName());
                target = null;
                dest = null;
                return;
            case "abort":
                reset(true);
                return;
            default:
                throw new IOException("unknown message");
        }
    }

    private void begin(JSONObject m) throws IOException, JSONException {
        String kind = m.optString("target");
        File file;
        File last = null;
        switch (kind) {
            case "stage":
                file = stagedFile(context, m.optString("xfer"));
                break;
            case "store":
                // The temp suffix desktop/store.ts uses, which keys() skips.
                last = MbrdStore.fileFor(m.getString("store"), m.getString("key"));
                file = new File(last.getPath() + ".tmp");
                break;
            case "file":
                // The temp suffix desktop/files.ts's write() uses.
                last = MbrdFiles.checked(m.getString("path"));
                file = new File(last.getPath() + ".mbrd-tmp");
                break;
            case "ff":
                // MbrdFfmpeg arrives with group N.
                throw new IOException("the ff target is not wired yet");
            default:
                file = null;
        }
        if (file == null) throw new IOException("no such target");
        expected = m.optLong("size", -1);
        written = 0;
        target = file;
        dest = last;
        out = new BufferedOutputStream(new FileOutputStream(file), 1 << 20);
    }

    private void write(byte[] data) throws IOException {
        if (out == null) throw new IOException("no transfer open");
        if (expected >= 0 && written + data.length > expected) throw new IOException("more bytes than announced");
        out.write(data);
        written += data.length;
    }

    /** Close whatever is open. A partial file is never left to look finished,
     *  including one whose stream "end" had already closed. */
    private void reset(boolean deletePartial) {
        if (out != null) {
            try {
                out.close();
            } catch (IOException ignored) {}
            out = null;
        }
        if (deletePartial && target != null) {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
        }
        target = null;
        dest = null;
    }

    private static String error(String message) {
        try {
            return new JSONObject().put("ok", false).put("error", message == null ? "failed" : message).toString();
        } catch (JSONException e) {
            return "{\"ok\":false}";
        }
    }
}
