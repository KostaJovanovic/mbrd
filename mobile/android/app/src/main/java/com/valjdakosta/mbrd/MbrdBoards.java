package com.valjdakosta.mbrd;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.provider.DocumentsContract;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.util.Locale;

/**
 * The boards folder, MbrdRoot.boards(): Documents/mbrd with the storage grant.
 * Desktop twin: desktop/boards.ts, whose five calls these are, under its names
 * (MbrdNames.plainName and nthName). A new board's bytes come through MbrdBytes
 * (target "create"), which takes its name from freeFile() here at the end.
 * Android has no bin for a file that is not a picture or a clip, so the bin is
 * .trash/ inside the folder, where a board stays BIN_DAYS days. Beside it is
 * .backups/, the rolling copies MbrdBackups keeps before a save.
 */
@CapacitorPlugin(name = "MbrdBoards")
public class MbrdBoards extends Plugin {

    private static final String TAG = "MbrdBoards";
    private static final String BIN = ".trash";
    private static final long BIN_DAYS = 30;

    /** Held while a name is chosen and taken, so two boards never get one name. */
    static final Object NAMES = new Object();

    @Override
    public void load() {
        // Off the main thread: the root may be waiting for the store to move.
        new Thread(MbrdBoards::sweepBin, "mbrd-bin-sweep").start();
    }

    /** This run's folder, canonical, made if it is missing. */
    static File folder() throws IOException {
        File dir = MbrdRoot.boards().getCanonicalFile();
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("could not make " + dir);
        return dir;
    }

    /** Phone storage matches names without case, as Windows does. */
    private static boolean same(File a, File b) {
        return a.getPath().equalsIgnoreCase(b.getPath());
    }

    /** The first free file for `name` in `dir`. `self`, a board being renamed,
     *  does not count as taking its own name. */
    static File freeFile(File dir, String name, File self) throws IOException {
        for (int n = 1; n <= 999; n++) {
            File f = new File(dir, MbrdNames.nthName(name, n));
            if ((self != null && same(f, self)) || !f.exists()) return f;
        }
        throw new IOException("the boards folder has too many boards with that name");
    }

    static JSObject ref(File file) {
        JSObject o = new JSObject();
        o.put("name", file.getName());
        o.put("path", file.getPath());
        return o;
    }

    /** The folder and its boards. Hidden files and a write's temp file are not boards. */
    @PluginMethod
    public void list(PluginCall call) {
        try {
            File dir = folder();
            JSArray files = new JSArray();
            File[] entries = dir.listFiles();
            if (entries != null) for (File f : entries) {
                String name = f.getName();
                if (!f.isFile() || name.startsWith(".") || !name.toLowerCase(Locale.ROOT).endsWith(".mbrd")) continue;
                JSObject o = ref(f);
                o.put("at", f.lastModified());
                files.put(o);
            }
            JSObject r = new JSObject();
            r.put("folder", dir.getPath());
            r.put("files", files);
            call.resolve(r);
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    /** Rename a board in the folder. A file elsewhere keeps its name, and the
     *  answer is empty, which the page reads as null. */
    @PluginMethod
    public void rename(PluginCall call) {
        try {
            File from = MbrdFiles.checked(call.getString("path"));
            File dir = folder();
            if (!dir.equals(from.getParentFile())) {
                call.resolve();
                return;
            }
            File to;
            synchronized (NAMES) {
                to = freeFile(dir, MbrdNames.plainName(call.getString("suggested")), from);
                if (same(to, from)) to = from;
                else if (!from.renameTo(to)) throw new IOException("could not rename " + from.getName());
            }
            call.resolve(ref(to));
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    /** Move a board in the folder to the bin, where it stays BIN_DAYS days. */
    @PluginMethod
    public void trash(PluginCall call) {
        try {
            File file = MbrdFiles.checked(call.getString("path"));
            File dir = folder();
            if (!dir.equals(file.getParentFile())) throw new IOException("only a board in the boards folder goes to the bin from here");
            File bin = new File(dir, BIN);
            if (!bin.isDirectory() && !bin.mkdirs()) throw new IOException("could not make the bin");
            synchronized (NAMES) {
                File to = new File(bin, MbrdNames.freeName(bin, file.getName()));
                if (!file.renameTo(to)) throw new IOException("could not move " + file.getName() + " to the bin");
                // A rename keeps the time of the last write. The bin counts from now.
                //noinspection ResultOfMethodCallIgnored
                to.setLastModified(System.currentTimeMillis());
            }
            call.resolve();
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    /** Open the folder in Files. Only Documents/mbrd can be: the app's own
     *  folder is closed to every other app. */
    @PluginMethod
    public void reveal(PluginCall call) {
        if (!MbrdRoot.isPublic()) {
            call.reject("the boards are in the app's own folder, which no file manager can open");
            return;
        }
        Uri uri = DocumentsContract.buildDocumentUri(
            "com.android.externalstorage.documents",
            "primary:" + Environment.DIRECTORY_DOCUMENTS + "/mbrd"
        );
        Intent intent = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, DocumentsContract.Document.MIME_TYPE_DIR)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("no file manager on this phone opens a folder");
        }
    }

    /** What has been in the bin for longer than BIN_DAYS goes for good. */
    private static void sweepBin() {
        try {
            File[] old = new File(folder(), BIN).listFiles();
            long cutoff = System.currentTimeMillis() - BIN_DAYS * 24 * 60 * 60 * 1000;
            if (old != null) for (File f : old) {
                if (f.lastModified() >= cutoff) continue;
                MbrdRoot.deleteTree(f);
                Logger.info(TAG, "emptied from the bin: " + f.getName());
            }
        } catch (IOException | RuntimeException e) {
            Logger.warn(TAG, "could not sweep the bin: " + e.getMessage());
        }
    }
}
