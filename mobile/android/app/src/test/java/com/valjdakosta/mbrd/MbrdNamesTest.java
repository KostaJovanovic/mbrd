package com.valjdakosta.mbrd;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

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

    /** The same answers as plainName() and nthName() in desktop/board-names.mts,
     *  so a boards folder names its boards alike on both. */
    @Test
    public void aBoardInTheFolderIsNamedAsTheDesktopNamesIt() {
        assertEquals("My Board.mbrd", MbrdNames.plainName("My Board"));
        assertEquals("abc.mbrd", MbrdNames.plainName("a/b:c"));
        assertEquals("X.mbrd", MbrdNames.plainName("X.MBRD"));
        assertEquals("hidden.mbrd", MbrdNames.plainName("  ..hidden"));
        assertEquals("trail.mbrd", MbrdNames.plainName("trail. "));
        assertEquals("a b.mbrd", MbrdNames.plainName("a \t  b"));
        assertEquals("board.mbrd", MbrdNames.plainName(""));
        assertEquals("board.mbrd", MbrdNames.plainName(null));
        assertEquals("_con.mbrd", MbrdNames.plainName("con"));
        assertEquals("_COM1.notes.mbrd", MbrdNames.plainName("COM1.notes"));
        assertEquals("b.mbrd", MbrdNames.nthName("b.mbrd", 1));
        assertEquals("b_(2).mbrd", MbrdNames.nthName("b.mbrd", 2));
    }

    /** MbrdFiles.checked(): only a board directly in the folder, as on the
     *  desktop. A picture there, a subfolder, the bin and the store are the
     *  person's own or the app's, and never the page's to read or write. */
    @Test
    public void thePageMayNameOnlyABoardDirectlyInTheFolder() {
        File root = new File("/storage/emulated/0/Documents/mbrd");
        assertTrue(MbrdNames.isFolderBoard(root, new File(root, "Summer.mbrd")));
        assertTrue(MbrdNames.isFolderBoard(root, new File(root, "SUMMER.MBRD")));
        assertFalse(MbrdNames.isFolderBoard(root, new File(root, "Personal/passport.jpg")));
        assertFalse(MbrdNames.isFolderBoard(root, new File(root, "Personal/x.mbrd")));
        assertFalse(MbrdNames.isFolderBoard(root, new File(root, "passport.jpg")));
        assertFalse(MbrdNames.isFolderBoard(root, new File(root, "Personal")));
        assertFalse(MbrdNames.isFolderBoard(root, new File(root, ".trash/x.mbrd")));
        assertFalse(MbrdNames.isFolderBoard(root, new File(root, ".store/kv/x.mbrd")));
        assertFalse(MbrdNames.isFolderBoard(root, new File(root, ".hidden.mbrd")));
        assertFalse(MbrdNames.isFolderBoard(root, new File(root, "x.mbrd.mbrd-tmp")));
        assertFalse(MbrdNames.isFolderBoard(root, root));
        assertFalse(MbrdNames.isFolderBoard(root, new File("/storage/emulated/0/Documents/x.mbrd")));
    }

    /** MbrdBoards' bin counts from the time in the name, which shared storage
     *  cannot refuse as it can refuse setLastModified(). */
    @Test
    public void theBinCountsFromTheTimeInTheName() {
        long now = 1_790_000_000_000L;
        String name = MbrdNames.binName(now, "trip.mbrd");
        assertEquals("1790000000000-trip.mbrd", name);
        assertEquals(now, MbrdNames.binnedAt(name, 5));
        assertEquals(now, MbrdNames.binnedAt(name.replace(".mbrd", " (2).mbrd"), 5));
        // Binned before the name carried it: the modified time, as it was.
        assertEquals(5, MbrdNames.binnedAt("trip.mbrd", 5));
        assertEquals(5, MbrdNames.binnedAt("2024-trip.mbrd", 5));
    }

    /** MbrdRoot.moveBoards: the shelf's row follows its board out of the
     *  private folder, and the bytes after the JSON line stay where they were. */
    @Test
    public void aMovedBoardsPathIsRewrittenInTheJsonLineOnly() {
        String old = "/data/user/0/com.valjdakosta.mbrd/files/mbrd/trip.mbrd";
        String now = "/storage/emulated/0/Documents/mbrd/trip.mbrd";
        java.util.Map<String, String> moved = java.util.Collections.singletonMap(old, now);
        byte[] raw = ("{\"v\":1,\"value\":[{\"id\":\"a\",\"path\":\"" + old + "\"},{\"path\":\"" + old + "x\"}]}\n"
            + old).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        String out = new String(MbrdNames.repath(raw, moved), java.nio.charset.StandardCharsets.UTF_8);
        assertEquals("{\"v\":1,\"value\":[{\"id\":\"a\",\"path\":\"" + now + "\"},{\"path\":\"" + old + "x\"}]}\n" + old, out);
        byte[] untouched = "{\"v\":1,\"value\":{}}\n".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        assertTrue(MbrdNames.repath(untouched, moved) == untouched);
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
