package com.valjdakosta.mbrd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import org.junit.Test;

/**
 * MbrdNames against fileFor() in desktop/store.ts: the names must be the
 * desktop's, byte for byte, or a store copied between the two loses values.
 * Runs on the host (gradlew testDebugUnitTest).
 */
public class MbrdNamesTest {

    @Test
    public void keysAreNamedAsEncodeUriComponentNamesThem() throws IOException {
        assertEquals("board%3A42", MbrdNames.fileName("board:42"));
        assertEquals("a%20b", MbrdNames.fileName("a b"));
        assertEquals("%C3%A4", MbrdNames.fileName("ä"));
        assertEquals("-_.!~*'()", MbrdNames.fileName("-_.!~*'()"));
        assertEquals("a%2Fb", MbrdNames.fileName("a/b"));
        assertEquals("%2B", MbrdNames.fileName("+"));
    }

    @Test
    public void aTrailingDotIsEncodedAsWindowsWouldDropIt() throws IOException {
        assertEquals("x%2E", MbrdNames.fileName("x."));
        assertEquals(".%2E", MbrdNames.fileName(".."));
    }

    @Test
    public void theDesktopsRefusalsAreRefusalsHere() {
        assertThrows(IOException.class, () -> MbrdNames.fileName("Upper"));
        assertThrows(IOException.class, () -> MbrdNames.fileName(""));
        assertThrows(IOException.class, () -> MbrdNames.fileName(null));
        StringBuilder long201 = new StringBuilder();
        for (int i = 0; i < 201; i++) long201.append('a');
        assertThrows(IOException.class, () -> MbrdNames.fileName(long201.toString()));
    }

    @Test
    public void aNameReadsBackAsItsKey() throws IOException {
        for (String key : new String[] { "board:42", "ä b+c", "x.", "sha256-abc/def" }) {
            assertEquals(key, MbrdNames.decodeComponent(MbrdNames.fileName(key)));
        }
        assertEquals("a+b", MbrdNames.decodeComponent("a+b"));
        assertNull(MbrdNames.decodeComponent("%zz"));
        assertNull(MbrdNames.decodeComponent("%4"));
    }

    @Test
    public void aBoardNameLosesWhatAFolderCannotHold() {
        assertEquals("a_b_c.mbrd", MbrdNames.safeName("a/b:c.mbrd", "x"));
        assertEquals("store", MbrdNames.safeName(".store", "x"));
        assertEquals("x", MbrdNames.safeName("  ", "x"));
        StringBuilder long130 = new StringBuilder();
        for (int i = 0; i < 130; i++) long130.append('a');
        String cut = MbrdNames.safeName(long130 + ".mbrd", "x");
        assertEquals(120, cut.length());
        assertEquals(".mbrd", MbrdNames.extension(cut));
    }

    @Test
    public void aClashGetsTheNextNumber() throws IOException {
        File dir = Files.createTempDirectory("mbrd-names").toFile();
        try {
            assertEquals("b.mbrd", MbrdNames.freeName(dir, "b.mbrd"));
            assertEquals(true, new File(dir, "b.mbrd").createNewFile());
            assertEquals("b (2).mbrd", MbrdNames.freeName(dir, "b.mbrd"));
            assertEquals(true, new File(dir, "b (2).mbrd").createNewFile());
            assertEquals("b (3).mbrd", MbrdNames.freeName(dir, "b.mbrd"));
        } finally {
            File[] left = dir.listFiles();
            if (left != null) for (File f : left) //noinspection ResultOfMethodCallIgnored
                f.delete();
            //noinspection ResultOfMethodCallIgnored
            dir.delete();
        }
    }
}
