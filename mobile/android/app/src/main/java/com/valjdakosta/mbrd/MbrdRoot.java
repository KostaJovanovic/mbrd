package com.valjdakosta.mbrd;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Environment;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Logger;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;

/**
 * Where the boards and the store live for this run. Desktop twin: userData, and
 * the fallback from a read-only portable folder, in desktop/main.ts. With the
 * storage grant it is Documents/mbrd/, the store in .store/ inside it, so both
 * survive an uninstall. Without it ("Not now") it is the app's private files
 * folder, which an uninstall removes. MainActivity picks one before the bridge.
 */
final class MbrdRoot {

    private static final String TAG = "MbrdRoot";

    private static volatile File boards;
    private static volatile File privateBoards;
    private static volatile boolean shared;
    private static volatile CountDownLatch ready = new CountDownLatch(0);

    private MbrdRoot() {}

    /** All files access on Android 11 and later, the write permission before. */
    static boolean granted(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return Environment.isExternalStorageManager();
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    @SuppressWarnings("deprecation")
    static File publicBoards() {
        // Deprecated for apps without all files access, which is exactly when
        // this is not used.
        return new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "mbrd");
    }

    /**
     * Pick this run's folder. When the grant has arrived and Documents/mbrd/ has
     * no store yet, the private store moves there once, on a thread of its own:
     * every read of the root waits for it.
     */
    static synchronized void use(Context ctx, boolean publicRoot) {
        privateBoards = new File(ctx.getFilesDir(), "mbrd");
        shared = publicRoot;
        boards = publicRoot ? publicBoards() : privateBoards;
        File to = new File(boards, ".store");
        File from = new File(privateBoards, ".store");
        if (!publicRoot || !holdsValues(from) || holdsValues(to)) {
            //noinspection ResultOfMethodCallIgnored
            to.mkdirs();
            return;
        }
        CountDownLatch latch = new CountDownLatch(1);
        ready = latch;
        new Thread(
            () -> {
                try {
                    move(from, to);
                } finally {
                    latch.countDown();
                }
            },
            "mbrd-store-move"
        ).start();
    }

    /** This run's folder for boards: Documents/mbrd/ or the private one. */
    static File boards() {
        try {
            ready.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (boards == null) throw new IllegalStateException("MainActivity has not picked a folder yet");
        return boards;
    }

    static File store() {
        return new File(boards(), ".store");
    }

    /** True when the boards are in Documents/mbrd/. */
    static boolean isPublic() {
        return shared;
    }

    /** Every folder a board may live in: this run's, and the private one, where
     *  a "Not now" run saved its boards. Canonical, for MbrdFiles.checked(). */
    static List<File> boardRoots() {
        List<File> roots = new ArrayList<>();
        for (File f : new File[] { boards(), privateBoards }) {
            try {
                if (f != null) roots.add(f.getCanonicalFile());
            } catch (IOException ignored) {
                // A folder that cannot be resolved holds no board to hand out.
            }
        }
        return roots;
    }

    /** Whether any of the four stores under `store` holds a value. */
    private static boolean holdsValues(File store) {
        for (String name : MbrdStore.STORES) {
            File[] files = new File(store, name).listFiles();
            if (files != null && files.length > 0) return true;
        }
        return false;
    }

    /** Copy beside the target, rename into place, then delete the private copy.
     *  A failure leaves the private store as it was, and the next run tries again. */
    private static void move(File from, File to) {
        File staging = new File(to.getParentFile(), ".store.moving");
        try {
            deleteTree(staging);
            copyTree(from, staging);
            // It holds no values (use() checked), only empty folders.
            deleteTree(to);
            if (!staging.renameTo(to)) throw new IOException("could not rename " + staging + " to " + to);
            deleteTree(from);
            Logger.info(TAG, "moved the store into " + to);
        } catch (IOException e) {
            Logger.error(TAG, "could not move the store into Documents/mbrd, so it stays private this run", e);
            deleteTree(staging);
            //noinspection ResultOfMethodCallIgnored
            to.mkdirs();
            boards = privateBoards;
            shared = false;
        }
    }

    private static void copyTree(File from, File to) throws IOException {
        if (from.isDirectory()) {
            if (!to.isDirectory() && !to.mkdirs()) throw new IOException("could not make " + to);
            File[] children = from.listFiles();
            if (children == null) throw new IOException("could not list " + from);
            for (File child : children) copyTree(child, new File(to, child.getName()));
            return;
        }
        try (InputStream in = new FileInputStream(from); OutputStream out = new FileOutputStream(to)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    static void deleteTree(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
