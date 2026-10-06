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
import com.getcapacitor.Logger;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.RandomAccessFile;
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
 *   {"op":"begin","target":"append","path":..,"at":N,"size":N}    a Save's tail
 *   {"op":"begin","target":"create","suggested":..,"size":N}      a new board
 *   {"op":"begin","target":"stage","xfer":..,"size":N}            for a share
 *   {"op":"begin","target":"ff",..}                                group N
 *   ArrayBuffer | {"op":"chunk","b64":..}                         repeated
 *   {"op":"end"} | {"op":"abort"}
 * Every message gets exactly one JSON ack, in order: {"ok":true} or
 * {"ok":false,"error":..}, and a create's "end" adds the board's name and path. The page waits for each ack before the next send, so
 * one chunk at most is in flight. Only the app origin (and the dev server) can
 * post: MbrdShell registers the listener with those origins. A store value and a
 * board go to a temp name and are renamed at the end, so a cut transfer never
 * replaces a whole file. A tail goes onto the end of its board, and a cut one is
 * cut back off. MbrdStore and MbrdFiles check every name and path.
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
    /** A "create": the name `target` is renamed to the first free form of, at the end. */
    private String createAs;
    /** The board an "append" writes onto, instead of `target`, and its length before. */
    private RandomAccessFile tail;
    private long tailAt;
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
                ack = handle(text, bytes);
            } catch (Exception e) {
                reset(true);
                ack = error(e.getMessage());
            }
            final String result = ack;
            main.post(() -> reply.postMessage(result));
        });
    }

    /** One message, and the ack it gets. */
    private String handle(String text, byte[] bytes) throws IOException, JSONException {
        if (bytes != null) {
            write(bytes);
            return OK;
        }
        JSONObject m = new JSONObject(text == null ? "{}" : text);
        switch (m.optString("op")) {
            case "begin":
                reset(true);
                begin(m);
                return OK;
            case "chunk":
                write(Base64.decode(m.getString("b64"), Base64.DEFAULT));
                return OK;
            case "end":
                if (out == null) throw new IOException("no transfer open");
                out.close();
                out = null;
                if (expected >= 0 && written != expected) {
                    throw new IOException("transfer was short: " + written + " of " + expected + " bytes");
                }
                if (tail != null) {
                    // On the disk before the page hears it is, as desktop/files.ts.
                    // A failed sync leaves `tail` set, and reset() cuts it back.
                    RandomAccessFile done = tail;
                    done.getFD().sync();
                    tail = null;
                    done.close();
                    return OK;
                }
                if (createAs != null) {
                    // Named now rather than at the start, so a board that took
                    // the name meanwhile is never replaced. The ack says where.
                    File made;
                    synchronized (MbrdBoards.NAMES) {
                        made = MbrdBoards.freeFile(target.getParentFile(), createAs, null);
                        if (!target.renameTo(made)) throw new IOException("could not write " + made.getName());
                    }
                    target = null;
                    createAs = null;
                    return MbrdBoards.ref(made).put("ok", true).toString();
                }
                if (dest != null && !target.renameTo(dest)) throw new IOException("could not write " + dest.getName());
                target = null;
                dest = null;
                return OK;
            case "abort":
                reset(true);
                return OK;
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
                backup(last);
                file = new File(last.getPath() + ".mbrd-tmp");
                break;
            case "append": {
                File board = MbrdFiles.checked(m.getString("path"));
                backup(board);
                beginAppend(board, m.getLong("at"), m.optLong("size", -1));
                return;
            }
            case "create":
                // A new board in the folder (desktop/boards.ts's create()). The
                // temp name ends in -tmp, so the folder's list skips it.
                createAs = MbrdNames.plainName(m.getString("suggested"));
                file = new File(MbrdBoards.folder(), createAs + ".mbrd-tmp");
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

    /** A copy of the board as it is, before the save changes it (MbrdBackups). Never stops the save. */
    private static void backup(File board) {
        try {
            MbrdBackups.keep(board, new File(MbrdBoards.folder(), MbrdBackups.DIR), System.currentTimeMillis());
        } catch (IOException | RuntimeException e) {
            Logger.warn("MbrdBytes", "could not keep a backup of " + board.getName() + ": " + e.getMessage());
        }
    }

    /**
     * desktop/files.ts's append(): only onto a file exactly `at` bytes long,
     * which is how long the page's last write left it. Anything else means the
     * file changed under the page, which then writes it whole. Unbuffered: every
     * chunk is already 4 MB, and a stream over the file's descriptor would close
     * it before reset() could cut a failed tail back off.
     */
    private void beginAppend(File board, long at, long size) throws IOException {
        if (at < 0 || !board.isFile()) throw new IOException(board.getName() + " is not there any more");
        RandomAccessFile raf = new RandomAccessFile(board, "rw");
        try {
            if (raf.length() != at) throw new IOException("the file changed on disk since it was last written");
            raf.seek(at);
        } catch (IOException e) {
            raf.close();
            throw e;
        }
        tail = raf;
        tailAt = at;
        expected = size;
        written = 0;
        out = new OutputStream() {
            @Override
            public void write(int b) throws IOException {
                raf.write(b);
            }

            @Override
            public void write(byte[] b, int off, int len) throws IOException {
                raf.write(b, off, len);
            }
        };
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
        if (tail != null) {
            // The last whole save stays standing.
            try {
                if (deletePartial) tail.setLength(tailAt);
            } catch (IOException ignored) {}
            try {
                tail.close();
            } catch (IOException ignored) {}
            tail = null;
        }
        target = null;
        dest = null;
        createAs = null;
    }

    private static String error(String message) {
        try {
            return new JSONObject().put("ok", false).put("error", message == null ? "failed" : message).toString();
        } catch (JSONException e) {
            return "{\"ok\":false}";
        }
    }
}
