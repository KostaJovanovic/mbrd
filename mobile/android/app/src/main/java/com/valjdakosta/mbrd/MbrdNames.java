package com.valjdakosta.mbrd;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

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
