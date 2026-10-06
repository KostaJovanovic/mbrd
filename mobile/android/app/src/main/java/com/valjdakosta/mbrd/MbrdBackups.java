package com.valjdakosta.mbrd;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.SimpleDateFormat;
import java.util.Arrays;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Rolling backups of each board file, taken before a save overwrites it, in
 * .backups/ inside the boards folder beside the bin. Desktop twin:
 * desktop/backups.mts, with the same numbers: one copy per board per fifteen
 * minutes, the newest ten, and under 2 GB a board with the newest two aside.
 * A failure is logged by the caller and never stops the save.
 */
final class MbrdBackups {

    static final String DIR = ".backups";
    private static final long INTERVAL_MS = 15 * 60 * 1000L;
    private static final int KEEP = 10;
    private static final int MIN_KEEP = 2;
    private static final long BUDGET_BYTES = 2L * 1024 * 1024 * 1024;

    private MbrdBackups() {}

    /** The copy made, or null when the board is not on disk or the last copy is recent. */
    static File keep(File board, File dir, long now) throws IOException {
        if (!board.isFile() || board.length() == 0) return null;
        File folder = folderFor(dir, board);
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("could not make " + folder.getName());
        File[] copies = sorted(folder);
        if (copies.length > 0 && now - copies[copies.length - 1].lastModified() < INTERVAL_MS) return null;
        File copy = new File(folder, stamp(now));
        File staging = new File(folder, copy.getName() + "-tmp");
        try (InputStream in = new FileInputStream(board); OutputStream out = new FileOutputStream(staging)) {
            byte[] buf = new byte[1 << 20];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
        if (!staging.renameTo(copy)) {
            //noinspection ResultOfMethodCallIgnored
            staging.delete();
            throw new IOException("could not keep a backup of " + board.getName());
        }
        prune(sorted(folder));
        return copy;
    }

    /** The board's name and a hash of its path, as desktop/backups.mts's folderFor(). */
    static File folderFor(File dir, File board) {
        String name = board.getName().replaceAll("(?i)\\.mbrd$", "").replaceAll("[^\\p{L}\\p{N} _-]+", "").trim();
        if (name.length() > 40) name = name.substring(0, 40);
        if (name.isEmpty()) name = "board";
        return new File(dir, name + "-" + tag(board.getPath()));
    }

    private static String tag(String path) {
        try {
            byte[] sum = MessageDigest.getInstance("SHA-256").digest(path.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 4; i++) hex.append(String.format(Locale.ROOT, "%02x", sum[i]));
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            return Integer.toHexString(path.hashCode());
        }
    }

    /** Sorts by time and is legal on every file system. */
    private static String stamp(long at) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss-SSS'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(at)) + ".mbrd";
    }

    private static File[] sorted(File folder) {
        File[] list = folder.listFiles((d, n) -> n.endsWith(".mbrd"));
        if (list == null) return new File[0];
        Arrays.sort(list, (a, b) -> a.getName().compareTo(b.getName()));
        return list;
    }

    /** Oldest first out, until both limits hold. */
    private static void prune(File[] copies) {
        long total = 0;
        for (File f : copies) total += f.length();
        for (int i = 0; i < copies.length; i++) {
            int left = copies.length - i;
            if (left <= MIN_KEEP) break;
            if (left <= KEEP && total <= BUDGET_BYTES) break;
            total -= copies[i].length();
            //noinspection ResultOfMethodCallIgnored
            copies[i].delete();
        }
    }
}
