package com.valjdakosta.mbrd;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The version comparison MbrdUpdate uses to decide whether a release is newer.
 *  The release tag reads "0.310.0" (desktop/scripts/version.mjs); the installed
 *  versionName reads "0.309" (mobile/tools/stamp-version.mjs). A port of
 *  FileAnalyser's AnrUpdateTest. */
public class MbrdUpdateTest {

    @Test
    public void newerReleasesWin() {
        assertTrue(MbrdUpdate.newer("0.310.0", "0.309"));
        assertTrue(MbrdUpdate.newer("0.1000.0", "0.999"));
        assertTrue(MbrdUpdate.newer("1.0.0", "0.999"));
    }

    @Test
    public void sameOrOlderDoesNot() {
        assertFalse(MbrdUpdate.newer("0.310.0", "0.310"));
        assertFalse(MbrdUpdate.newer("0.309.0", "0.310"));
        assertFalse(MbrdUpdate.newer("0.99.0", "0.100"));
    }

    @Test
    public void semverOfALeadingZeroMatchesItsLabel() {
        // version.mjs turns the label 1.05 into 1.5.0, and the APK keeps "1.05".
        assertFalse(MbrdUpdate.newer("1.5.0", "1.05"));
        assertTrue(MbrdUpdate.newer("1.6.0", "1.05"));
    }

    @Test
    public void junkNeverCountsAsNewer() {
        assertFalse(MbrdUpdate.newer("", "0.310"));
        assertFalse(MbrdUpdate.newer("latest", "0.310"));
    }
}
