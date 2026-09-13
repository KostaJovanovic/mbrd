package com.valjdakosta.mbrd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.util.Arrays;
import java.util.HashSet;
import org.junit.Test;

/**
 * MbrdRouter against the rules of readPage() in desktop/protocol.ts, on a small
 * staged tree. Runs on the host (gradlew testDebugUnitTest), with no WebView.
 */
public class MbrdRouterTest {

    private final MbrdRouter router = new MbrdRouter(
        new HashSet<>(Arrays.asList("index.html", "patch.html", "download.html", "assets/app.js", "assets/icons.svg", "docs/index.html"))
    );

    @Test
    public void theRootAndAFolderGetIndexHtml() {
        assertEquals("index.html", router.route("/"));
        assertEquals("index.html", router.route(""));
        assertEquals("docs/index.html", router.route("/docs/"));
    }

    @Test
    public void aPathWithNoExtensionTriesHtmlFirst() {
        assertEquals("patch.html", router.route("/patch"));
        assertEquals("download.html", router.route("/download"));
    }

    @Test
    public void aFileIsServedAsItIs() {
        assertEquals("assets/app.js", router.route("/assets/app.js"));
        assertEquals("patch.html", router.route("/patch.html"));
    }

    @Test
    public void whatIsNotStagedIsA404AndNotTheBoard() {
        assertNull(router.route("/nothing"));
        assertNull(router.route("/assets/missing.js"));
        assertNull(router.route("/docs"));
    }

    @Test
    public void nothingClimbsOutOfTheTree() {
        assertNull(router.route("/../index.html"));
        assertNull(router.route("/assets/../index.html"));
        assertNull(router.route("/./index.html"));
        assertNull(router.route("/assets\\app.js"));
        assertNull(router.route("/assets//app.js"));
    }

    @Test
    public void theContentTypesAreTheDesktops() {
        assertEquals("text/javascript", MbrdRouter.mime("assets/app.js"));
        assertEquals("text/javascript", MbrdRouter.mime("assets/vendor/pdfjs/pdf.worker.min.mjs"));
        assertEquals("application/wasm", MbrdRouter.mime("a.wasm"));
        assertEquals("application/json", MbrdRouter.mime("manifest.webmanifest"));
        assertEquals("application/octet-stream", MbrdRouter.mime("assets.v2/README"));
    }
}
