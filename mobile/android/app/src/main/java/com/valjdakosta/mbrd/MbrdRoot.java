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
     * Pick this run's folder. When the grant has arrived, the private store
     * moves to Documents/mbrd/ once (when that has no store yet), and every
     * board a "Not now" run saved privately moves with it, on a thread of its
     * own: every read of the root waits for it.
     */
    static synchronized void use(Context ctx, boolean publicRoot) {
        privateBoards = new File(ctx.getFilesDir(), "mbrd");
        shared = publicRoot;
        boards = publicRoot ? publicBoards() : privateBoards;
        File to = new File(boards, ".store");
        File from = new File(privateBoards, ".store");
        boolean moveStore = publicRoot && holdsValues(from) && !holdsValues(to);
        if (!moveStore && !(publicRoot && privateBoardFiles().length > 0)) {
            //noinspection ResultOfMethodCallIgnored
            to.mkdirs();
            return;
        }
        CountDownLatch latch = new CountDownLatch(1);
        ready = latch;
        new Thread(
            () -> {
                try {
                    if (moveStore) move(from, to);
                    if (shared) moveBoards(to);
                } finally {
                    latch.countDown();
                }
            },
            "mbrd-store-move"
        ).start();
    }

    /** The boards directly in the private folder. */
    private static File[] privateBoardFiles() {
        File[] found = privateBoards.listFiles(f -> f.isFile() && MbrdNames.isFolderBoard(privateBoards, f));
        return found == null ? new File[0] : found;
    }

    /**
     * The private boards into Documents/mbrd/, which "Not now" said allowing
     * access would do, before an uninstall takes them. Each is copied and
     * flushed under a free name (or found there already, from a run that died
     * before the delete), every stored value naming its old path is rewritten,
     * and only then is the private copy deleted. Whatever fails stays private,
     * where boardRoots() still reaches it, and the next run tries again.
     */
    private static void moveBoards(File store) {
        java.util.Map<String, String> moved = new java.util.LinkedHashMap<>();
        for (File board : privateBoardFiles()) {
            try {
                File from = board.getCanonicalFile();
                File dest;
                synchronized (MbrdBoards.NAMES) {
                    dest = landingFor(boards, from);
                    if (!dest.exists()) {
                        File tmp = new File(dest.getPath() + ".mbrd-tmp");
                        try {
                            copyFile(from, tmp);
                        } catch (IOException e) {
                            //noinspection ResultOfMethodCallIgnored
                            tmp.delete();
                            throw e;
                        }
                        if (!tmp.renameTo(dest)) throw new IOException("could not write " + dest.getName());
                    }
                }
                moved.put(from.getPath(), dest.getCanonicalPath());
            } catch (IOException e) {
                Logger.warn(TAG, "could not move " + board.getName() + " into Documents/mbrd: " + e.getMessage());
            }
        }
        if (moved.isEmpty()) return;
        try {
            repathValues(new File(store, "kv"), moved);
        } catch (IOException e) {
            // The shelf still names the private copies, which stay. The public
            // ones are found again by their bytes next run, not copied twice.
            Logger.error(TAG, "could not point the shelf at the moved boards, so they stay private this run", e);
            return;
        }
        for (String path : moved.keySet()) {
            //noinspection ResultOfMethodCallIgnored
            new File(path).delete();
            Logger.info(TAG, "moved " + path + " to " + moved.get(path));
        }
    }

    /** Where `board` lands in `dir`: a file there already holding its bytes,
     *  else the first free name. */
    private static File landingFor(File dir, File board) throws IOException {
        for (int n = 1; n <= 999; n++) {
            File f = new File(dir, MbrdNames.nthName(MbrdNames.plainName(board.getName()), n));
            if (!f.exists() || sameBytes(f, board)) return f;
        }
        throw new IOException("the boards folder has too many boards named " + board.getName());
    }

    /** Whether two files hold the same bytes. */
    static boolean sameBytes(File a, File b) throws IOException {
        if (!a.isFile() || !b.isFile() || a.length() != b.length()) return false;
        try (InputStream x = new FileInputStream(a); InputStream y = new FileInputStream(b)) {
            byte[] p = new byte[1 << 16];
            byte[] q = new byte[1 << 16];
            while (true) {
                int n = fill(x, p);
                if (fill(y, q) != n) return false;
                for (int i = 0; i < n; i++) if (p[i] != q[i]) return false;
                if (n < p.length) return true;
            }
        }
    }

    /** As many bytes as `buf` holds, or fewer only at the end of the stream.
     *  InputStream.readNBytes is API 33. */
    private static int fill(InputStream in, byte[] buf) throws IOException {
        int at = 0;
        int n;
        while (at < buf.length && (n = in.read(buf, at, buf.length - at)) > 0) at += n;
        return at;
    }

    /** Every value in `kv` that names a moved board's old path, rewritten to the
     *  new one: the shelf's rows and the session's open board. Temp and rename,
     *  as MbrdBytes writes them. */
    private static void repathValues(File kv, java.util.Map<String, String> moved) throws IOException {
        File[] values = kv.listFiles(f -> f.isFile() && !f.getName().endsWith(".tmp"));
        if (values == null) return;
        for (File value : values) {
            byte[] raw = java.nio.file.Files.readAllBytes(value.toPath());
            byte[] out = MbrdNames.repath(raw, moved);
            if (out == raw) continue;
            File tmp = new File(value.getPath() + ".tmp");
            try (FileOutputStream o = new FileOutputStream(tmp)) {
                o.write(out);
                o.getFD().sync();
            }
            if (!tmp.renameTo(value)) throw new IOException("could not rewrite " + value.getName());
        }
    }

    private static void copyFile(File from, File to) throws IOException {
        try (InputStream in = new FileInputStream(from); FileOutputStream out = new FileOutputStream(to)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.getFD().sync();
        }
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
