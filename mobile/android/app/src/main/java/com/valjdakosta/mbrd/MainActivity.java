package com.valjdakosta.mbrd;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;

/**
 * The one activity: Capacitor's BridgeActivity with the shell's plugins, and the
 * question of where the boards live. Desktop twin: the BrowserWindow that
 * desktop/main.ts opens, and its choice of a data folder. It also owns what the
 * desktop's frame does: the insets (natively, so the page needs no safe-area
 * CSS), the bar colour, full screen in landscape, Back, and "Open with".
 *
 * Before the bridge loads, it checks the storage grant. Without it, a screen
 * says why mbrd wants it, with Allow and Not now. The bridge cannot wait for the
 * answer: Capacitor registers its activity-result launchers while it builds the
 * bridge, and Android refuses that once the activity has started. So this
 * instance builds no bridge, and the answer recreates the activity, which then
 * builds it in onCreate as usual.
 */
public class MainActivity extends BridgeActivity {

    private static final int ASK_STORAGE = 7001;
    // manifest.json's paper and the app's ink.
    private static final int PAPER = 0xFFFAF8F3;
    private static final int INK = 0xFF2B2722;

    /** "Not now", for the rest of this process. The next launch asks again. */
    private static boolean notNow = false;
    /** True while Android's All files access page is open. */
    private boolean inSettings = false;
    /** Whether the bars are hidden now, so a repeat of the same decision does
     *  nothing. Null until the first. Calling hide or show on every resume and
     *  every configuration change made the bars flicker. */
    private Boolean fullscreen = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Before super.onCreate(): the bridge is built there, and a plugin
        // registered afterwards is never loaded.
        registerPlugin(MbrdShell.class);
        registerPlugin(MbrdStore.class);
        registerPlugin(MbrdFiles.class);
        registerPlugin(MbrdAuth.class);
        super.onCreate(savedInstanceState);
        setUpInsets();
        applyFullscreen(getResources().getConfiguration(), true);
        setUpBack();
        // Returns at once, and does nothing unless the build has an update feed.
        // Not while the storage screen is up: the answer recreates the activity,
        // which would take the dialog with it, and the check waits six hours.
        if (bridge != null) MbrdUpdate.maybeCheck(this);
    }

    /** BridgeActivity.onCreate() calls this to build the bridge. */
    @Override
    protected void load() {
        boolean granted = MbrdRoot.granted(this);
        if (!granted && !notNow) {
            explain();
            return;
        }
        MbrdRoot.use(this, granted);
        super.load();
    }

    /** Also runs for the launch intent: BridgeActivity.load() calls it once. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        MbrdShell shell = shell();
        if (shell == null) {
            // The storage screen is up. Keep the intent for the bridge the
            // answer builds, which reads it in load().
            setIntent(intent);
            return;
        }
        // Swap the handled intent out, so a restore does not open it twice.
        if (shell.deliver(intent)) setIntent(new Intent(Intent.ACTION_MAIN));
    }

    private MbrdShell shell() {
        if (bridge == null) return null;
        PluginHandle handle = bridge.getPlugin("MbrdShell");
        return handle == null ? null : (MbrdShell) handle.getInstance();
    }

    @Override
    public void onResume() {
        super.onResume();
        // Coming back from another app can bring the bars back, so this one
        // applies the decision even when it has not changed.
        applyFullscreen(getResources().getConfiguration(), true);
        if (inSettings && bridge == null) {
            inSettings = false;
            // Back from Android's page. Without the grant the screen stays, and
            // Not now is still there.
            if (MbrdRoot.granted(this)) recreate();
        }
    }

    /** The manifest handles orientation changes itself (configChanges), so the
     *  activity lives on and a turn of the phone lands here. */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // uiMode is in configChanges, so the phone going dark lands here too.
        applyBars(newConfig);
        applyFullscreen(newConfig, false);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        // BridgeActivity drops every result while there is no bridge, so this
        // one is taken first.
        if (requestCode == ASK_STORAGE && bridge == null) {
            if (MbrdRoot.granted(this)) recreate();
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    // ---- insets and the bar colour -------------------------------------------

    /** FileAnalyser's: the WebView's parent is padded from the insets, keyboard
     *  included, so the page gets an ordinary viewport. capacitor.config.json
     *  turns Capacitor's own inset handling off (SystemBars). */
    private void setUpInsets() {
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Draw beside the camera in landscape too, so the strip that keeps
            // the page clear of it takes the page colour, not black.
            WindowManager.LayoutParams lp = window.getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            window.setAttributes(lp);
        }
        if (Build.VERSION.SDK_INT < 35) {
            // Android 15 and later draw transparent bars themselves.
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
        }
        applyBars(getResources().getConfiguration());

        View decor = window.getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(decor, (v, insets) -> {
            int bars = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
            Insets sys = insets.getInsets(bars);
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            boolean keyboard = insets.isVisible(WindowInsetsCompat.Type.ime());
            v.setPadding(sys.left, sys.top, sys.right, keyboard ? Math.max(ime.bottom, sys.bottom) : sys.bottom);
            // Not WindowInsetsCompat.CONSUMED: Capacitor's SystemBars notes that
            // it breaks the WebView's own inset recalculation (Chromium 461332423).
            return new WindowInsetsCompat.Builder(insets).setInsets(bars, Insets.NONE).build();
        });
    }

    /** Landscape is full screen: the bars hide, and a swipe from the edge shows
     *  them for a moment. Portrait keeps them. Only a change of decision calls
     *  hide or show, unless `force` (a resume, where another app may have
     *  brought the bars back). */
    private void applyFullscreen(Configuration config, boolean force) {
        boolean want = config.orientation == Configuration.ORIENTATION_LANDSCAPE;
        if (!force && fullscreen != null && fullscreen == want) return;
        fullscreen = want;
        Window window = getWindow();
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        if (want) {
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    /** The padded bands show the window background: black when the phone is in
     *  dark mode, white in light mode, with the bar icons to match. They used to
     *  follow the page's colour through a bridge call, and a flood of those calls
     *  (every menu, every step of the whimsy slider) made the bars flicker. The
     *  window's background, not the decor view's: a turn of the phone resets the
     *  decor view to the window background. */
    private void applyBars(Configuration config) {
        boolean dark = (config.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        Window window = getWindow();
        window.setBackgroundDrawable(new ColorDrawable(dark ? Color.BLACK : Color.WHITE));
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);
    }

    // ---- Back -----------------------------------------------------------------

    /** The page decides first (window.__mbrdBack, mobile/bridge/lifecycle.ts):
     *  it closes its top layer. With nothing left open the app goes to the
     *  background, and does not finish, so the board is still there. */
    private void setUpBack() {
        getOnBackPressedDispatcher().addCallback(
            this,
            new OnBackPressedCallback(true) {
                @Override
                public void handleOnBackPressed() {
                    if (bridge == null || bridge.getWebView() == null) {
                        moveTaskToBack(true);
                        return;
                    }
                    bridge
                        .getWebView()
                        .evaluateJavascript(
                            "(function(){try{return window.__mbrdBack?window.__mbrdBack():'exit'}catch(e){return 'exit'}})()",
                            value -> {
                                if (value == null || !value.contains("handled")) moveTaskToBack(true);
                            }
                        );
                }
            }
        );
    }

    // ---- the storage screen ---------------------------------------------------

    private void allow() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            inSettings = true;
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + getPackageName())));
            } catch (ActivityNotFoundException e) {
                try {
                    // Some makers leave out the per-app page. This one lists every app.
                    startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                } catch (ActivityNotFoundException e2) {
                    inSettings = false;
                    notNow = true;
                    recreate();
                }
            }
        } else {
            ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.WRITE_EXTERNAL_STORAGE }, ASK_STORAGE);
        }
    }

    /** The explanation screen, in place of the WebView until there is an answer. */
    private void explain() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(PAPER);
        int pad = dp(32);
        box.setPadding(pad, pad, pad, pad);

        box.addView(line("Keep your boards as files", 24));
        box.addView(
            line(
                "mbrd keeps your boards as files in Documents/mbrd, so they survive an uninstall and show in Files. "
                    + "Allow opens the Android page for this. Turn on the access there, then come back.",
                16
            )
        );

        Button allow = new Button(this);
        allow.setText("Allow");
        allow.setOnClickListener(v -> allow());
        box.addView(allow);

        Button later = new Button(this);
        later.setText("Not now");
        later.setOnClickListener(v -> {
            notNow = true;
            recreate();
        });
        box.addView(later);

        setContentView(box);
    }

    private TextView line(String text, int sp) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(INK);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setGravity(Gravity.CENTER);
        view.setPadding(0, 0, 0, dp(20));
        return view;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
