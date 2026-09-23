package com.valjdakosta.mbrd;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The names the store and the files are kept under. Desktop twin: fileFor() and
 * keyOf() in desktop/store.ts, ported byte for byte, so a store folder copied
 * from a phone reads on the desktop. Pure Java with no Android class, so
 * MbrdNamesTest runs on the host.
 */
final class MbrdNames {

    static final int MAX_KEY_BYTES = 200;
    /** What encodeURIComponent leaves alone besides letters and digits. */
    private static final String UNRESERVED = "-_.!~*'()";
    private static final char[] HEX = "0123456789ABCDEF".toCharArray();
    private static final int MAX_NAME = 120;

    private MbrdNames() {}

    /** encodeURIComponent, as JavaScript spells it: UTF-8, upper-case hex. */
    static String encodeComponent(String s) {
        StringBuilder b = new StringBuilder();
        for (byte x : s.getBytes(StandardCharsets.UTF_8)) {
            int c = x & 0xff;
            boolean plain = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || UNRESERVED.indexOf(c) >= 0;
            if (plain) b.append((char) c);
            else b.append('%').append(HEX[c >> 4]).append(HEX[c & 15]);
        }
        return b.toString();
    }

    /** decodeURIComponent. Null for a name it cannot read. Unlike URLDecoder, '+' stays '+'. */
    static String decodeComponent(String s) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '%') {
                if (i + 2 >= s.length()) return null;
                int hi = Character.digit(s.charAt(i + 1), 16);
                int lo = Character.digit(s.charAt(i + 2), 16);
                if (hi < 0 || lo < 0) return null;
                out.write(hi * 16 + lo);
                i += 2;
            } else {
                byte[] bytes = String.valueOf(c).getBytes(StandardCharsets.UTF_8);
                out.write(bytes, 0, bytes.length);
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    /** A key's file name. The messages are desktop/store.ts's. */
    static String fileName(String key) throws IOException {
        if (key == null) throw new IOException("this store keys by string");
        if (!key.equals(key.toLowerCase(Locale.ROOT))) {
            throw new IOException("keys must be lowercase here - NTFS and APFS fold case: " + key);
        }
        String encoded = encodeComponent(key);
        // Windows drops a trailing dot, so a store copied there would lose it.
        if (encoded.endsWith(".")) encoded = encoded.substring(0, encoded.length() - 1) + "%2E";
        if (encoded.length() > MAX_KEY_BYTES) {
            throw new IOException("key is " + encoded.length() + " bytes encoded, over the " + MAX_KEY_BYTES + " ceiling");
        }
        if (encoded.isEmpty()) throw new IOException("an empty key has no filename");
        return encoded;
    }

    /**
     * A name a board file can have: no separator, no character Windows refuses,
     * no leading dot (MbrdFiles refuses hidden names), and at most 120
     * characters with the extension kept. `fallback` when nothing is left.
     */
    static String safeName(String name, String fallback) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F\\x7F]", "_").trim();
        while (n.startsWith(".")) n = n.substring(1);
        if (n.length() > MAX_NAME) {
            String ext = extension(n);
            n = n.substring(0, MAX_NAME - ext.length()) + ext;
        }
        return n.isEmpty() ? fallback : n;
    }

    /** ".mbrd" for "a.mbrd", "" when there is none. */
    static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 && name.length() - dot <= 10 ? name.substring(dot) : "";
    }

    private static final String BOARD_EXT = ".mbrd";
    private static final Pattern DEVICE = Pattern.compile("^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$", Pattern.CASE_INSENSITIVE);

    /**
     * A board's name in the boards folder: desktop/board-names.mts's plainName(),
     * ported, so a folder copied between a phone and a computer names its boards
     * alike. No folder, no hidden dot, nothing Windows refuses, and .mbrd.
     */
    static String plainName(String suggested) {
        String stem = (suggested == null ? "" : suggested)
            .replaceAll("(?i)\\.mbrd$", "")
            .replaceAll("[<>:\"/\\\\|?*\\x00-\\x1F]", "")
            // JS's \s, spelled out: Android's regex engine refuses Java's
            // Unicode-classes flag, and every board write threw on it
            // (tests/android-regex.test.js).
            .replaceAll("[\\s\\p{Z}\\uFEFF]+", " ")
            .replaceAll("^[. ]+", "");
        if (stem.length() > MAX_NAME) stem = stem.substring(0, MAX_NAME);
        stem = stem.replaceAll("[. ]+$", "");
        if (stem.isEmpty()) stem = "board";
        if (DEVICE.matcher(stem.split("\\.")[0]).matches()) stem = "_" + stem;
        return stem + BOARD_EXT;
    }

    /** The nth choice for a board's name: "name.mbrd", then "name_(2).mbrd" and
     *  on, as nthName() in desktop/board-names.mts. */
    static String nthName(String name, int n) {
        if (n <= 1) return name;
        return name.substring(0, name.length() - BOARD_EXT.length()) + "_(" + n + ")" + BOARD_EXT;
    }

    /**
     * Whether `file` is a board directly in `root`, not hidden, ending in
     * .mbrd: the only kind of path in a board folder the page may name without
     * this process handing it out. Both canonical. desktop/board-names.mts's
     * isFolderBoard() is the same rule.
     */
    static boolean isFolderBoard(File root, File file) {
        File parent = file.getParentFile();
        if (parent == null || !parent.getPath().equals(root.getPath())) return false;
        String name = file.getName();
        return !name.startsWith(".") && name.toLowerCase(Locale.ROOT).endsWith(BOARD_EXT);
    }

    /** `name`, or "name (2).ext" and on, whichever `dir` does not hold yet. */
    static String freeName(File dir, String name) {
        if (!new File(dir, name).exists()) return name;
        String ext = extension(name);
        String stem = name.substring(0, name.length() - ext.length());
        for (int i = 2; ; i++) {
            String candidate = stem + " (" + i + ")" + ext;
            if (!new File(dir, candidate).exists()) return candidate;
        }
    }
}
