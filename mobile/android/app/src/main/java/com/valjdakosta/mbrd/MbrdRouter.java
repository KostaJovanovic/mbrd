package com.valjdakosta.mbrd;

import android.content.res.AssetManager;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Which staged file a request path names. Desktop twin: readPage() and mimeOf()
 * in desktop/protocol.ts. Change one and change both.
 *
 * Capacitor's own server answers index.html for every path with no extension,
 * and its RouteProcessor only ever sees "/index.html", so it cannot route. This
 * does what the desktop does: a path ending in / gets index.html, a path with no
 * extension tries <path>.html first (/patch, /privacy), and nothing
 * outside the staged tree is served. The tree is mbrd-files.txt, which
 * stage-web.mjs writes, so each "does this exist" is a set lookup.
 */
final class MbrdRouter {

    private final Set<String> files;

    MbrdRouter(AssetManager assets) {
        this(listing(assets));
    }

    /** For the unit test: the staged tree as a set of '/'-separated paths. */
    MbrdRouter(Set<String> files) {
        this.files = files;
    }

    private static Set<String> listing(AssetManager assets) {
        Set<String> set = new HashSet<>(4096);
        try (
            BufferedReader r = new BufferedReader(new InputStreamReader(assets.open("mbrd-files.txt"), StandardCharsets.UTF_8))
        ) {
            String line;
            while ((line = r.readLine()) != null) {
                if (!line.isEmpty()) set.add(line);
            }
        } catch (IOException e) {
            // No listing, no routes: every request is a 404, which says loudly
            // that stage-web.mjs did not run.
            return Collections.emptySet();
        }
        return set;
    }

    /**
     * The staged file to serve, as a path under public/ with no leading slash, or
     * null for a 404.
     *
     * @param path the request path, already percent-decoded (Uri.getPath()).
     */
    String route(String path) {
        String rel = path == null || path.isEmpty() ? "/" : path;
        if (rel.endsWith("/")) rel += "index.html";
        rel = rel.replaceFirst("^/+", "");
        // Refused before any lookup. The desktop resolves and then checks
        // containment; a set of staged paths has nothing to resolve against.
        for (String seg : rel.split("/", -1)) {
            if (seg.isEmpty() || seg.equals("..") || seg.equals(".") || seg.contains("\\")) return null;
        }
        boolean named = rel.matches("(?s).*\\.[A-Za-z0-9]+$");
        if (!named && files.contains(rel + ".html")) return rel + ".html";
        return files.contains(rel) ? rel : null;
    }

    /** The content type for a staged file, as mimeOf() in desktop/protocol.ts. */
    static String mime(String file) {
        int dot = file.lastIndexOf('.');
        String ext = dot < 0 || dot < file.lastIndexOf('/') ? "" : file.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (ext) {
            case "html":
                return "text/html";
            case "js":
            case "mjs":
                return "text/javascript";
            case "css":
                return "text/css";
            case "json":
            case "webmanifest":
                return "application/json";
            case "wasm":
                return "application/wasm";
            case "svg":
                return "image/svg+xml";
            case "png":
                return "image/png";
            case "jpg":
            case "jpeg":
                return "image/jpeg";
            case "webp":
                return "image/webp";
            case "ico":
                return "image/x-icon";
            case "woff2":
                return "font/woff2";
            case "woff":
                return "font/woff";
            case "txt":
            case "md":
                return "text/plain";
            case "xml":
                return "application/xml";
            default:
                return "application/octet-stream";
        }
    }

    /** The types mimeOf() sends with charset=utf-8. */
    static boolean isText(String mime) {
        return mime.startsWith("text/") || mime.equals("application/json") || mime.equals("application/xml");
    }
}
