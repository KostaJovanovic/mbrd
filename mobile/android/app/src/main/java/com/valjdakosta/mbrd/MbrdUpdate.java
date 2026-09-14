package com.valjdakosta.mbrd;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.os.Build;
import android.widget.Toast;
import androidx.core.content.IntentCompat;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Updates for the APK, from the public KostaJovanovic/mbrd-release
 * (.github/workflows/release.yml). A port of FileAnalyser's AnrUpdate.java.
 *
 * Only a build with an update feed checks: BuildConfig.UPDATE_FEED, which the
 * release workflow sets with -PmbrdUpdateFeed. A mobile.bat build has none and
 * never checks. A Google Play build must have none either, and must also drop
 * REQUEST_INSTALL_PACKAGES from the manifest: Play forbids an app that updates
 * itself.
 *
 * The feed is GitHub's API answer for the latest release. There is no update
 * file in the release: the answer gives the tag (v0.310.0), and for the asset
 * named mbrd-android-<version>.apk its download URL, its size and the SHA-256
 * digest GitHub computed for it.
 *
 * At most one check a day, at start-up. A newer tag downloads in the
 * background, and the page's sidebar shows an Update row (the "update" event,
 * MbrdShell). Where Data Saver restricts background data on a metered network
 * nothing downloads, and a press on the row downloads it in the foreground,
 * with the row counting. The panel's "Check for updates" answers on the page
 * too: the row for a new version, the page's toast otherwise. Nothing here
 * opens a dialog (research/old/done-2026-09-15.md, R7). Android's own
 * install-confirm screen, below, is the system's. Every download checks its SHA-256, its package name
 * and that its versionCode is higher, and an install writes it into a
 * PackageInstaller session. On Android 12 and later the session asks for no
 * confirm screen (USER_ACTION_NOT_REQUIRED), which Android grants to an app
 * that updates itself: the update installs and mbrd closes. Where Android
 * still wants a yes - an older version, or a case it does not allow - the
 * session reports that, and InstallStatus opens the confirm screen. Android
 * itself refuses an APK signed with another key, so the signature check is
 * the platform's. Play Protect can still scan the new APK either way.
 *
 * What a check sends: one HTTPS request to api.github.com. Nothing about any board.
 */
// Public, because Android creates the nested InstallStatus receiver by name.
public final class MbrdUpdate {

    private static final String PREFS = "mbrd-update";
    private static final long EVERY_MS = 24L * 60 * 60 * 1000;
    /** The API answer carries the release notes and every asset. */
    private static final int FEED_MAX = 512 * 1024;
    /** The APK's name ends in the version (mbrd-android-0.310.0.apk), so it is
     *  found by the part before it. An unversioned name still matches.
     *  tests/desktop-package.test.js reads this literal. */
    private static final Pattern APK_NAME = Pattern.compile("^mbrd-android(-\\d+(\\.\\d+)*)?\\.apk$");
    private static final Pattern DIGEST = Pattern.compile("^sha256:([0-9a-f]{64})$");
    private static final ExecutorService NET = Executors.newSingleThreadExecutor();
    /** True while a check or a download runs, so two can never overlap. */
    private static final AtomicBoolean BUSY = new AtomicBoolean(false);

    private interface Progress {
        void at(int permille);
    }

    /** Where the page hears of an update: MbrdShell's "update" event. `state`
     *  is one of platform.ts's UpdateOfferState: available, ready, downloading,
     *  failed, or said for a passing answer. Any other takes the row away. */
    interface Announce {
        void send(String state, String version, int permille, String note);
    }

    private static volatile Announce announce = (state, version, permille, note) -> {};
    /** Downloaded and checked, waiting for the row's press. */
    private static volatile File readyFile = null;
    private static volatile String readyVersion = "";
    /** Found, and not downloaded yet: a press downloads it first. */
    private static volatile JSONObject waiting = null;
    private static volatile String waitingVersion = "";

    private MbrdUpdate() {}

    /** MbrdShell.load() sets this before MainActivity's first check. */
    static void onOffer(Announce a) {
        announce = a;
    }

    /** The sidebar's Update row (MbrdShell.installUpdate). A downloaded update
     *  installs. One not downloaded yet downloads first, with the row counting. */
    static void installNow(Activity activity) {
        Context app = activity.getApplicationContext();
        File file = readyFile;
        if (file != null && file.isFile()) {
            NET.execute(() -> {
                boolean taken = true;
                try {
                    install(app, file);
                } catch (Exception e) {
                    taken = false;
                }
                // The session holds its own copy once written.
                deleteQuietly(file);
                readyFile = null;
                if (!taken) {
                    announce.send("none", "", 0, "");
                    say("Android did not take the update. mbrd tries again at the next start.");
                }
            });
            return;
        }
        JSONObject apk = waiting;
        if (apk != null) download(app, apk, waitingVersion);
    }

    /** A passing answer, for the page's toast. */
    private static void say(String note) {
        announce.send("said", "", 0, note);
    }

    private static String label(String version) {
        return version.replaceFirst("\\.0$", "");
    }

    /** Found and not downloaded: the row offers it, and a press downloads it. */
    private static void offerLater(String version, JSONObject apk) {
        waiting = apk;
        waitingVersion = version;
        announce.send("available", version, 0,
            "mbrd " + label(version) + " is out. Press to download it. Your board is saved, then mbrd closes to install it.");
    }

    /** Downloaded and checked: the row offers it, and a press installs it. */
    private static void offerReady(File file, String version) {
        readyFile = file;
        readyVersion = version;
        announce.send("ready", version, 0,
            "mbrd " + label(version) + " is ready. Your board is saved, then mbrd closes to install it.");
    }

    /** Data Saver is on and the network is metered: no download in the background. */
    private static boolean restricted(Context app) {
        ConnectivityManager cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        return cm.isActiveNetworkMetered()
            && cm.getRestrictBackgroundStatus() == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED;
    }

    /** Where a background download waits. Not the cache, which Android may empty
     *  before the press. */
    private static File readyApk(Context app) {
        return new File(new File(app.getFilesDir(), "update"), "mbrd.apk");
    }

    /** A download from an earlier run, still newer than the installed copy, is
     *  offered again at once. One that is not is deleted. Runs on NET. */
    private static void resumeReady(Context app) {
        File kept = readyApk(app);
        if (!kept.isFile()) return;
        try {
            verify(app, kept);
            PackageInfo p = app.getPackageManager().getPackageArchiveInfo(kept.getPath(), 0);
            offerReady(kept, p != null && p.versionName != null ? p.versionName : "");
        } catch (Exception e) {
            deleteQuietly(kept);
        }
    }

    /** The daily check found `version`: download it quietly, or wait for the
     *  press where Data Saver says so. Runs on NET, inside the check. */
    private static void background(Context app, String version, JSONObject apk) {
        if (restricted(app)) {
            offerLater(version, apk);
            return;
        }
        String url = apk.optString("browser_download_url", "");
        Matcher digest = DIGEST.matcher(apk.optString("digest", ""));
        if (!url.startsWith("https://") || !digest.matches()) return;
        File file = readyApk(app);
        try {
            save(url, file, digest.group(1), new AtomicBoolean(false), permille -> {});
            verify(app, file);
            offerReady(file, version);
        } catch (Exception e) {
            // Offline, or a bad file. The next day's check tries again.
            deleteQuietly(file);
        }
    }

    /** Called from MainActivity.onCreate. Returns at once: the work runs on NET.
     *  A download already waiting is offered again, and no check runs. */
    static void maybeCheck(Activity activity) {
        check(activity, false);
    }

    /** The panel's "Check for updates" (MbrdShell.checkUpdates): no day's
     *  wait, and it always answers on the page - the Update row for a new
     *  version, the page's toast otherwise. */
    static void checkNow(Activity activity) {
        check(activity, true);
    }

    private static void check(Activity activity, boolean manual) {
        String feed = BuildConfig.UPDATE_FEED;
        if (feed == null || feed.isEmpty()) {
            if (manual) say("Updates are off in this build of mbrd.");
            return;
        }
        if (!BUSY.compareAndSet(false, true)) {
            if (manual) say("mbrd is already checking for an update.");
            return;
        }
        Context app = activity.getApplicationContext();
        SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        NET.execute(() -> {
            try {
                // The installer copied the last update when it ran, so the file is spare now.
                deleteQuietly(apkFile(app));
                if (readyFile == null) resumeReady(app);
                if (readyFile != null) {
                    // Downloaded already: the row offers it, and says so again when asked.
                    if (manual) offerReady(readyFile, readyVersion);
                    return;
                }
                if (!manual && System.currentTimeMillis() - prefs.getLong("checked", 0) < EVERY_MS) return;
                HttpURLConnection c = open(feed, "application/vnd.github+json");
                JSONObject release;
                try {
                    release = new JSONObject(readAll(c.getInputStream(), FEED_MAX));
                } finally {
                    c.disconnect();
                }
                prefs.edit().putLong("checked", System.currentTimeMillis()).apply();
                String version = release.optString("tag_name", "").replaceFirst("^v", "");
                JSONObject apk = asset(release, APK_NAME);
                if (apk == null || !newer(version, installedName(app))) {
                    if (manual) say("mbrd is up to date.");
                    return;
                }
                // Asked for, it waits for the row's press. Found by the daily
                // check, it downloads quietly first.
                if (manual) offerLater(version, apk);
                else background(app, version, apk);
            } catch (Exception e) {
                // Offline, or GitHub did not answer. The next start tries again.
                if (manual) say("mbrd could not reach GitHub. Check the connection, then try again.");
            } finally {
                BUSY.set(false);
            }
        });
    }

    /** True when version `a` is newer than `b`, compared number by number:
     *  "0.310.0" is newer than "0.309", and "0.310.0" is the same as "0.310". */
    static boolean newer(String a, String b) {
        String[] x = a.split("\\.");
        String[] y = b.split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? number(x[i]) : 0;
            int q = i < y.length ? number(y[i]) : 0;
            if (p != q) return p > q;
        }
        return false;
    }

    private static int number(String s) {
        try {
            return Integer.parseInt(s.trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static JSONObject asset(JSONObject release, Pattern name) {
        JSONArray assets = release.optJSONArray("assets");
        if (assets == null) return null;
        for (int i = 0; i < assets.length(); i++) {
            JSONObject a = assets.optJSONObject(i);
            if (a != null && name.matcher(a.optString("name")).matches()) return a;
        }
        return null;
    }

    /**
     * The row's press on an update not downloaded yet: download it in the
     * foreground, then install it. No dialog: the row counts the download, a
     * failure turns it into Retry update, and Android's own confirm screen is
     * the only thing that may still come up.
     */
    private static void download(Context app, JSONObject apk, String version) {
        final String url = apk.optString("browser_download_url", "");
        Matcher digest = DIGEST.matcher(apk.optString("digest", ""));
        // No digest, no install: the hash is what ties the file to the release.
        if (!url.startsWith("https://") || !digest.matches() || !BUSY.compareAndSet(false, true)) return;
        final String sha = digest.group(1);
        final String note = "Downloading mbrd " + label(version) + ". mbrd closes to install it when the download is done.";
        announce.send("downloading", version, 0, note);

        NET.execute(() -> {
            File file = apkFile(app);
            // Whole percent steps: the page repaints the row for each one.
            int[] told = {0};
            try {
                save(url, file, sha, new AtomicBoolean(false), permille -> {
                    if (permille - told[0] < 10) return;
                    told[0] = permille;
                    announce.send("downloading", version, permille, note);
                });
                verify(app, file);
                install(app, file);
                // Back to an offer: if Android's confirm screen is turned down,
                // a press downloads it again. On a yes Android closes mbrd.
                offerLater(version, apk);
            } catch (Exception e) {
                offerLater(version, apk);
                announce.send("failed", version, 0,
                    "mbrd " + label(version) + " did not download or install. Press to try again.");
            } finally {
                // The session holds its own copy once written, so the cached file is spare.
                deleteQuietly(file);
                BUSY.set(false);
            }
        });
    }

    /** Stream the APK to `file`, hashing as it goes. Throws on a cancel or a bad hash. */
    private static void save(String url, File file, String sha, AtomicBoolean cancelled, Progress progress) throws Exception {
        File dir = file.getParentFile();
        if (dir != null && !dir.isDirectory() && !dir.mkdirs()) throw new IOException("no cache folder");
        HttpURLConnection c = open(url, null);
        try {
            long total = c.getContentLengthLong();
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(file)) {
                byte[] buf = new byte[1 << 16];
                long got = 0;
                int last = -1;
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (cancelled.get()) throw new IOException("cancelled");
                    out.write(buf, 0, n);
                    digest.update(buf, 0, n);
                    got += n;
                    int permille = total > 0 ? (int) Math.min(1000, got * 1000 / total) : 0;
                    if (permille != last) {
                        last = permille;
                        progress.at(permille);
                    }
                }
            }
            if (!hex(digest.digest()).equals(sha)) throw new IOException("the download does not match its checksum");
        } finally {
            c.disconnect();
        }
    }

    /** The file must be mbrd, and newer than the copy that is installed. */
    private static void verify(Context app, File file) throws IOException {
        PackageInfo p = app.getPackageManager().getPackageArchiveInfo(file.getPath(), 0);
        if (p == null || !app.getPackageName().equals(p.packageName)) throw new IOException("not an mbrd package");
        if (versionCode(p) <= installedCode(app)) throw new IOException("not newer than the installed copy");
    }

    /** Write the verified APK into a PackageInstaller session and commit it.
     *  Runs on NET: the copy is tens of MB. Android reports the result to
     *  InstallStatus - see the header for which versions ask first. */
    private static void install(Context app, File file) throws IOException {
        PackageInstaller installer = app.getPackageManager().getPackageInstaller();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(app.getPackageName());
        params.setSize(file.length());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        }
        int id = installer.createSession(params);
        try {
            try (PackageInstaller.Session session = installer.openSession(id)) {
                try (InputStream in = new FileInputStream(file); OutputStream out = session.openWrite("mbrd.apk", 0, file.length())) {
                    byte[] buf = new byte[1 << 16];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    session.fsync(out);
                }
                // Mutable on Android 12 and later: Android writes the status into it.
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0);
                PendingIntent done = PendingIntent.getBroadcast(app, id, new Intent(app, InstallStatus.class), flags);
                session.commit(done.getIntentSender());
            }
        } catch (IOException | RuntimeException e) {
            installer.abandonSession(id);
            throw e;
        }
    }

    /**
     * Where Android reports on the install session. Declared in the manifest
     * and not exported, so only the PendingIntent above reaches it.
     *
     * STATUS_PENDING_USER_ACTION means Android wants a yes first. Its confirm
     * screen comes in EXTRA_INTENT, and the app is on screen at that moment
     * (the user just watched the download), so it may start it. On success
     * Android stops the app to replace it, so there is nothing to do.
     */
    public static final class InstallStatus extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent.class);
                if (confirm == null) return;
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    context.startActivity(confirm);
                } catch (RuntimeException e) {
                    Toast.makeText(context, "Android could not open its installer.", Toast.LENGTH_LONG).show();
                }
            } else if (status != PackageInstaller.STATUS_SUCCESS && status != PackageInstaller.STATUS_FAILURE_ABORTED) {
                // ABORTED is the user saying no on the confirm screen: no message.
                Toast.makeText(context, "Android did not install the update. mbrd tries again later.", Toast.LENGTH_LONG).show();
            }
        }
    }

    /** `accept` is set for the API only: the download URL wants no special type. */
    private static HttpURLConnection open(String url, String accept) throws IOException {
        URL u = new URL(url);
        if (!"https".equals(u.getProtocol())) throw new IOException("not https");
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        // github.com answers a release download with a redirect to its asset host.
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("Cache-Control", "no-cache");
        c.setRequestProperty("User-Agent", "mbrd-Android");
        if (accept != null) c.setRequestProperty("Accept", accept);
        int status = c.getResponseCode();
        if (status != HttpURLConnection.HTTP_OK) {
            c.disconnect();
            throw new IOException("HTTP " + status);
        }
        return c;
    }

    /** At most `max` bytes, as UTF-8. MbrdShell.readAll has no ceiling, and this
     *  reads from the network. */
    private static String readAll(InputStream in, int max) throws IOException {
        try (InputStream src = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = src.read(buf)) > 0) {
                if (out.size() + n > max) throw new IOException("reply too large");
                out.write(buf, 0, n);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String installedName(Context app) {
        try {
            String v = app.getPackageManager().getPackageInfo(app.getPackageName(), 0).versionName;
            return v == null ? "" : v;
        } catch (PackageManager.NameNotFoundException e) {
            return "";
        }
    }

    private static long installedCode(Context app) {
        try {
            return versionCode(app.getPackageManager().getPackageInfo(app.getPackageName(), 0));
        } catch (PackageManager.NameNotFoundException e) {
            return Long.MAX_VALUE; // our own package always exists; never install on a surprise
        }
    }

    @SuppressWarnings("deprecation")
    private static long versionCode(PackageInfo p) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? p.getLongVersionCode() : p.versionCode;
    }

    private static File apkFile(Context app) {
        return new File(new File(app.getCacheDir(), "update"), "mbrd.apk");
    }

    private static String hex(byte[] bytes) {
        StringBuilder s = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) s.append(String.format(Locale.ROOT, "%02x", b));
        return s.toString();
    }

    private static void deleteQuietly(File f) {
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
