package com.valjdakosta.mbrd;

import android.webkit.WebResourceResponse;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONException;

/**
 * The four stores, one file a key, under MbrdRoot.store(). Desktop twin:
 * desktop/store.ts, whose rules this keeps: the same four stores, the same file
 * names (MbrdNames), a write to a temp name and a rename, and a clear() that
 * renames the folder aside and deletes it after. The page encodes each value
 * with desktop/format.mts and this keeps the bytes as they come.
 *
 * A value arrives through MbrdBytes (target "store") and leaves as a plain GET
 * of /__mbrd/store/<store>/<key>, answered by serve(). keys, del, delMany and
 * clear are plugin methods.
 */
@CapacitorPlugin(name = "MbrdStore")
public class MbrdStore extends Plugin {

    private static final String TAG = "MbrdStore";

    static final List<String> STORES = Arrays.asList("kv", "assets", "library", "matte");

    @Override
    public void load() {
        // Off the main thread: the root may be waiting for the store to move.
        new Thread(MbrdStore::prepare, "mbrd-store-sweep").start();
    }

    /** The .nomedia marker, so gallery apps do not index hash-named pictures,
     *  and the sweep of the folders a clear() set aside. */
    private static void prepare() {
        File root = MbrdRoot.store();
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        try {
            //noinspection ResultOfMethodCallIgnored
            new File(root, ".nomedia").createNewFile();
        } catch (IOException e) {
            Logger.warn(TAG, "could not write .nomedia in " + root);
        }
        File[] names = root.listFiles();
        if (names == null) return;
        for (File f : names) {
            if (f.isDirectory() && f.getName().contains(".trash-")) {
                MbrdRoot.deleteTree(f);
                Logger.info(TAG, "collected a cleared store: " + f.getName());
            }
        }
    }

    static File dirOf(String store) throws IOException {
        if (store == null || !STORES.contains(store)) throw new IOException("unknown store: " + store);
        File dir = new File(MbrdRoot.store(), store);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    static File fileFor(String store, String key) throws IOException {
        return new File(dirOf(store), MbrdNames.fileName(key));
    }

    /** GET /__mbrd/store/<store>/<key>: the bytes, 404 for no value, 400 for a
     *  name the desktop would refuse, which the bridge turns into a rejection. */
    static WebResourceResponse serve(String store, String key) {
        File file;
        try {
            file = fileFor(store, key);
        } catch (IOException e) {
            return MbrdWebViewClient.text(400, e.getMessage());
        }
        try {
            return new WebResourceResponse(
                "application/octet-stream",
                null,
                200,
                "OK",
                MbrdWebViewClient.noStore(),
                new FileInputStream(file)
            );
        } catch (FileNotFoundException e) {
            return MbrdWebViewClient.status(404);
        }
    }

    @PluginMethod
    public void keys(PluginCall call) {
        try {
            File[] files = dirOf(call.getString("store")).listFiles();
            List<String> keys = new ArrayList<>();
            if (files != null) for (File f : files) {
                String name = f.getName();
                // .tmp files are writes in flight, not keys.
                if (!f.isFile() || name.endsWith(".tmp")) continue;
                String key = MbrdNames.decodeComponent(name);
                if (key != null) keys.add(key);
                else Logger.warn(TAG, "a file in the store is not a key: " + name);
            }
            JSObject r = new JSObject();
            r.put("keys", new JSArray(keys));
            call.resolve(r);
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void del(PluginCall call) {
        try {
            //noinspection ResultOfMethodCallIgnored
            fileFor(call.getString("store"), call.getString("key")).delete();
            call.resolve();
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void delMany(PluginCall call) {
        try {
            String store = call.getString("store");
            JSArray keys = call.getArray("keys", new JSArray());
            // Every name is checked before any file goes, so a bad key deletes nothing.
            List<File> files = new ArrayList<>();
            for (int i = 0; i < keys.length(); i++) files.add(fileFor(store, keys.getString(i)));
            for (File f : files) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
            call.resolve();
        } catch (IOException | JSONException e) {
            call.reject(e.getMessage());
        }
    }

    /** Atomic: the folder is renamed aside, so a clear either happened or did not. */
    @PluginMethod
    public void clear(PluginCall call) {
        try {
            File dir = dirOf(call.getString("store"));
            File aside = new File(dir.getPath() + ".trash-" + System.currentTimeMillis());
            if (!dir.renameTo(aside)) throw new IOException("could not clear " + dir.getName());
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            call.resolve();
            // A failure here leaves rubbish, not surviving data. prepare() sweeps it.
            new Thread(() -> MbrdRoot.deleteTree(aside), "mbrd-store-clear").start();
        } catch (IOException e) {
            call.reject(e.getMessage());
        }
    }
}
