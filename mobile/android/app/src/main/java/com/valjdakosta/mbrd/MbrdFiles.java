package com.valjdakosta.mbrd;

import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceResponse;
import android.widget.EditText;
import android.widget.FrameLayout;
import androidx.activity.result.ActivityResult;
import androidx.appcompat.app.AlertDialog;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Save, Open and Import. Desktop twin: desktop/files.ts, and its rule: the page
 * never names a path this side did not produce. Here that is a path under
 * MbrdRoot's folders (never a hidden one, so never the store), or one this
 * plugin handed out. checked() is that rule, for MbrdBytes' "file" target too.
 *
 * A file goes to the page as a token, which the bridge fetches from
 * /__mbrd/file/<token>. pickOpen copies a board from anywhere into this run's
 * folder, "name (2).mbrd" on a clash. pickImport streams the pictures, clips and
 * documents it is given and copies nothing: their bytes go into the store.
 */
@CapacitorPlugin(name = "MbrdFiles")
public class MbrdFiles extends Plugin {

    private static final String BOARD_EXT = ".mbrd";

    /** Canonical paths handed out by this process. Grows, as desktop/files.ts's does. */
    private static final Set<String> KNOWN = Collections.synchronizedSet(new HashSet<>());

    /** A file, or a content:// document, the page may fetch once it has the token. */
    private static final class Handed {

        final File file;
        final Uri uri;

        Handed(File file, Uri uri) {
            this.file = file;
            this.uri = uri;
        }
    }

    /** Tokens not fetched yet. Each serves once, and the bridge fetches each one
     *  at once. 1024 at most, so a share of 500 pictures (import/drop.ts's
     *  MAX_FILES) never pushes its own first tokens out before they are read. */
    private static final Map<String, Handed> TOKENS = Collections.synchronizedMap(
        new LinkedHashMap<String, Handed>(16, 0.75f, false) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Handed> eldest) {
                return size() > 1024;
            }
        }
    );

    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    // ---- the rule -------------------------------------------------------------

    /** The file a page-supplied path names, or an IOException when this side did
     *  not produce it. */
    static File checked(String path) throws IOException {
        if (path == null || path.isEmpty()) throw new IOException("that file was not opened by this app");
        File file = new File(path).getCanonicalFile();
        if (KNOWN.contains(file.getPath())) return file;
        for (File root : MbrdRoot.boardRoots()) {
            if (isPlainChild(root, file)) return file;
        }
        throw new IOException("that file was not opened by this app");
    }

    /** Under `root`, and no folder or name on the way starts with a dot. */
    private static boolean isPlainChild(File root, File file) {
        String rel = relative(root, file);
        if (rel == null || rel.isEmpty()) return false;
        for (String seg : rel.split("/")) if (seg.isEmpty() || seg.startsWith(".")) return false;
        return true;
    }

    private static String relative(File root, File file) {
        String r = root.getPath();
        String f = file.getPath();
        return f.startsWith(r + File.separator) ? f.substring(r.length() + 1).replace(File.separatorChar, '/') : null;
    }

    private static String token(Handed handed) {
        String token = UUID.randomUUID().toString();
        TOKENS.put(token, handed);
        return token;
    }

    /** GET /__mbrd/file/<token>: the file's bytes, streamed, not copied. */
    static WebResourceResponse serve(Context ctx, String token) {
        Handed h = TOKENS.remove(token);
        if (h == null) return MbrdWebViewClient.status(404);
        try {
            InputStream in = h.file != null ? new FileInputStream(h.file) : ctx.getContentResolver().openInputStream(h.uri);
            if (in == null) return MbrdWebViewClient.status(404);
            return new WebResourceResponse("application/octet-stream", null, 200, "OK", MbrdWebViewClient.noStore(), in);
        } catch (IOException | SecurityException e) {
            return MbrdWebViewClient.status(404);
        }
    }

    private static JSObject described(String name, String path, String token) {
        JSObject o = new JSObject();
        o.put("name", name);
        o.put("path", path);
        o.put("token", token);
        return o;
    }

    private static JSObject fileResult(File file) {
        KNOWN.add(file.getPath());
        JSObject r = new JSObject();
        r.put("file", described(file.getName(), file.getPath(), token(new Handed(file, null))));
        return r;
    }

    // ---- Save -----------------------------------------------------------------

    /** A native "Save as": a name field in this run's folder, and a question
     *  before it replaces a file. Resolves { name, path }, or {} when cancelled. */
    @PluginMethod
    public void pickSave(PluginCall call) {
        String suggested = MbrdNames.safeName(call.getString("suggested", ""), "board" + BOARD_EXT);
        File dir = MbrdRoot.boards();
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        getActivity().runOnUiThread(() -> askName(call, dir, suggested, suggested));
    }

    private void askName(PluginCall call, File dir, String name, String suggested) {
        Activity activity = getActivity();
        EditText field = new EditText(activity);
        field.setSingleLine(true);
        field.setText(name);
        String ext = MbrdNames.extension(name);
        field.setSelection(0, name.length() - ext.length());
        FrameLayout wrap = new FrameLayout(activity);
        int pad = Math.round(20 * activity.getResources().getDisplayMetrics().density);
        wrap.setPadding(pad, 0, pad, 0);
        wrap.addView(field);
        AlertDialog dialog = new AlertDialog.Builder(activity)
            .setTitle("Save as")
            .setMessage(MbrdRoot.isPublic() ? "In Documents/mbrd" : "In the app's own folder")
            .setView(wrap)
            .setPositiveButton("Save", (d, w) -> chosen(call, dir, field.getText().toString(), suggested))
            .setNegativeButton("Cancel", (d, w) -> call.resolve())
            .setOnCancelListener(d -> call.resolve())
            .create();
        if (dialog.getWindow() != null) dialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE);
        dialog.show();
    }

    private void chosen(PluginCall call, File dir, String typed, String suggested) {
        String name = MbrdNames.safeName(typed, "");
        if (name.isEmpty()) {
            call.resolve();
            return;
        }
        // The kind of file stays what the page asked for: a board stays .mbrd.
        String ext = MbrdNames.extension(suggested);
        if (!ext.isEmpty() && !name.toLowerCase(Locale.ROOT).endsWith(ext.toLowerCase(Locale.ROOT))) name += ext;
        File file = new File(dir, name);
        if (!file.exists()) {
            saved(call, file);
            return;
        }
        String finalName = name;
        new AlertDialog.Builder(getActivity())
            .setTitle("Replace " + name + "?")
            .setMessage("A file with this name is already in the folder.")
            .setPositiveButton("Replace", (d, w) -> saved(call, file))
            .setNegativeButton("Cancel", (d, w) -> askName(call, dir, finalName, suggested))
            .setOnCancelListener(d -> askName(call, dir, finalName, suggested))
            .show();
    }

    private void saved(PluginCall call, File file) {
        try {
            File canonical = file.getCanonicalFile();
            KNOWN.add(canonical.getPath());
            JSObject r = new JSObject();
            r.put("name", canonical.getName());
            r.put("path", canonical.getPath());
            call.resolve(r);
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    // ---- Open -----------------------------------------------------------------

    @PluginMethod
    public void pickOpen(PluginCall call) {
        // Android has no type for .mbrd, so the picker shows everything and
        // adopt() decides by the name or the ZIP magic.
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
        startActivityForResult(call, intent, "openDone");
    }

    @ActivityCallback
    private void openDone(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = result.getResultCode() == Activity.RESULT_OK && result.getData() != null ? result.getData().getData() : null;
        if (uri == null) {
            call.resolve();
            return;
        }
        Context ctx = getContext();
        IO.execute(() -> {
            try {
                call.resolve(fileResult(adopt(ctx, uri)));
            } catch (IOException | SecurityException e) {
                call.reject(e.getMessage());
            }
        });
    }

    /** The board as a file in this run's folder: itself when it already is one,
     *  a copy otherwise. */
    private static File adopt(Context ctx, Uri uri) throws IOException {
        File direct = directFile(ctx, uri);
        if (direct != null) return direct;
        String name = displayName(ctx, uri);
        boolean named = name.toLowerCase(Locale.ROOT).endsWith(BOARD_EXT);
        if (!named && !isZip(ctx, uri)) throw new IOException(name + " is not an mbrd board");
        File dir = MbrdRoot.boards();
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        String safe = MbrdNames.safeName(name, "board" + BOARD_EXT);
        if (!named) safe += BOARD_EXT;
        File dest = new File(dir, MbrdNames.freeName(dir, safe));
        File tmp = new File(dest.getPath() + ".mbrd-tmp");
        try (InputStream in = ctx.getContentResolver().openInputStream(uri); OutputStream out = new FileOutputStream(tmp)) {
            if (in == null) throw new IOException("could not read " + name);
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw e;
        }
        if (!tmp.renameTo(dest)) throw new IOException("could not save " + dest.getName());
        return dest.getCanonicalFile();
    }

    /** A document the system picker found in this run's folder, as a path, so
     *  opening a board from Documents/mbrd/ does not make "(2)" of it. */
    @SuppressWarnings("deprecation")
    private static File directFile(Context ctx, Uri uri) {
        if (!MbrdRoot.isPublic() || !"com.android.externalstorage.documents".equals(uri.getAuthority())) return null;
        if (!DocumentsContract.isDocumentUri(ctx, uri)) return null;
        String id = DocumentsContract.getDocumentId(uri);
        if (id == null || !id.startsWith("primary:")) return null;
        try {
            File file = new File(Environment.getExternalStorageDirectory(), id.substring("primary:".length())).getCanonicalFile();
            File root = MbrdRoot.boards().getCanonicalFile();
            return file.isFile() && isPlainChild(root, file) ? file : null;
        } catch (IOException e) {
            return null;
        }
    }

    private static boolean isZip(Context ctx, Uri uri) {
        try (InputStream in = ctx.getContentResolver().openInputStream(uri)) {
            byte[] head = new byte[4];
            return in != null && in.read(head) == 4 && head[0] == 'P' && head[1] == 'K' && head[2] == 3 && head[3] == 4;
        } catch (IOException | SecurityException e) {
            return false;
        }
    }

    private static String displayName(Context ctx, Uri uri) {
        try (Cursor c = ctx.getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) {
            // A provider that will not name the file still streams it.
        }
        String last = uri.getLastPathSegment();
        return last == null ? "file" : last;
    }

    // ---- Incoming (MbrdShell.deliver) -----------------------------------------

    private static final String BOARD_MIME = "application/vnd.mbrd+zip";

    /**
     * A file another app handed over, as the page will fetch it. A board (by its
     * name, its type, or the ZIP magic when the provider gives no extension) is
     * adopted into this run's folder and keeps its path, so Save writes back to
     * it. Anything else streams from its content URI and has no path.
     */
    static JSObject incoming(Context ctx, Uri uri, String intentType) throws IOException {
        String name = displayName(ctx, uri);
        String mime = ctx.getContentResolver().getType(uri);
        if (mime == null) mime = intentType == null ? "" : intentType;
        boolean board = name.toLowerCase(Locale.ROOT).endsWith(BOARD_EXT)
            || BOARD_MIME.equals(mime)
            || (MbrdNames.extension(name).isEmpty() && isZip(ctx, uri));
        if (board) {
            File file = adopt(ctx, uri);
            KNOWN.add(file.getPath());
            return described(file.getName(), file.getPath(), token(new Handed(file, null)));
        }
        return described(withExtension(name, mime), "", token(new Handed(null, uri)));
    }

    /** import/drop.ts sorts a file by its extension, and a gallery can hand
     *  over a name with none. */
    private static String withExtension(String name, String mime) {
        if (!MbrdNames.extension(name).isEmpty()) return name;
        String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
        return ext == null ? name : name + "." + ext;
    }

    // ---- Import ---------------------------------------------------------------

    @PluginMethod
    public void pickImport(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(call, intent, "importDone");
    }

    @ActivityCallback
    private void importDone(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getResultCode() == Activity.RESULT_OK ? result.getData() : null;
        List<Uri> uris = new ArrayList<>();
        if (data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
            else if (data.getData() != null) uris.add(data.getData());
        }
        JSArray files = new JSArray();
        for (Uri uri : uris) {
            if (uri == null) continue;
            files.put(described(displayName(getContext(), uri), "", token(new Handed(null, uri))));
        }
        JSObject r = new JSObject();
        r.put("files", files);
        call.resolve(r);
    }

    // ---- Read and exists ------------------------------------------------------

    /** A shelf row's file, read back. */
    @PluginMethod
    public void read(PluginCall call) {
        try {
            File file = checked(call.getString("path"));
            if (!file.isFile()) throw new IOException(file.getName() + " is not there any more");
            call.resolve(fileResult(file));
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    /** Whether a shelf row's file is still there. A path this side never
     *  produced is not, as on the desktop. */
    @PluginMethod
    public void exists(PluginCall call) {
        boolean there;
        try {
            there = checked(call.getString("path")).isFile();
        } catch (IOException e) {
            there = false;
        }
        JSObject r = new JSObject();
        r.put("exists", there);
        call.resolve(r);
    }
}
