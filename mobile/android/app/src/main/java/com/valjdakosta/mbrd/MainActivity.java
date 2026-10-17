package com.valjdakosta.mbrd;

import android.Manifest;
import android.app.Dialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Display;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
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
    /** The storage screen's (?) pop-up, while it is up. */
    private Dialog helpBox = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Before super.onCreate(): the bridge is built there, and a plugin
        // registered afterwards is never loaded.
        registerPlugin(MbrdShell.class);
        registerPlugin(MbrdStore.class);
        registerPlugin(MbrdFiles.class);
        registerPlugin(MbrdBoards.class);
        registerPlugin(MbrdAuth.class);
        registerPlugin(MbrdBench.class);
        super.onCreate(savedInstanceState);
        setUpInsets();
        applyFullscreen(getResources().getConfiguration(), true);
        setUpBack();
        askForTopRate();
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
        // The storage screen is drawn for one scheme and one width: draw it again,
        // and close its pop-up, which was drawn for the old one.
        if (bridge == null) {
            if (helpBox != null) helpBox.dismiss();
            explain();
        }
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
        // While the storage screen is up the bands take its sheet, so it is one piece.
        int bg = bridge == null ? (dark ? Palette.DARK : Palette.LIGHT).paper : (dark ? Color.BLACK : Color.WHITE);
        window.setBackgroundDrawable(new ColorDrawable(bg));
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);
    }

    // ---- refresh rate ---------------------------------------------------------

    /** The screen's top rate while the app is open. Left alone, Android 15 and
     *  later run the WebView at 60 Hz, and at 90 with a finger down (category
     *  High), on a 120 Hz screen. The window asks, not the WebView: a rate set
     *  on the view (setRequestedFrameRate) never reached SurfaceFlinger, since
     *  the WebView's frames do not pass through the view's own draw. Both
     *  fields, because a screen with one mode and several rates (the S22's)
     *  takes the mode and still lowers the rate unless asked for that too. */
    private void askForTopRate() {
        if (bridge == null) return;
        Display display = getWindowManager().getDefaultDisplay();
        Display.Mode now = display.getMode();
        Display.Mode top = now;
        for (Display.Mode m : display.getSupportedModes()) {
            if (m.getPhysicalWidth() == now.getPhysicalWidth() && m.getPhysicalHeight() == now.getPhysicalHeight()
                && m.getRefreshRate() > top.getRefreshRate()) top = m;
        }
        if (top.getRefreshRate() <= 61f) return;
        WindowManager.LayoutParams lp = getWindow().getAttributes();
        lp.preferredDisplayModeId = top.getModeId();
        lp.preferredRefreshRate = top.getRefreshRate();
        getWindow().setAttributes(lp);
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

    /** The explanation screen, in place of the WebView until there is an answer.
     *  Drawn in the app's own palette (tokens.css, light and dark) rather than
     *  stock Material: a serif heading, the folder named as a path on a card,
     *  one filled pill for Allow and a quiet Not now. What the two buttons do
     *  sits behind a (?) beside the path, see help(). No WebView exists yet, so
     *  the woff2 faces are out of reach; the system serif and sans stand in. */
    private void explain() {
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        Palette p = dark ? Palette.DARK : Palette.LIGHT;

        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(p.paper);

        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setGravity(Gravity.CENTER);
        int pad = dp(28);
        page.setPadding(pad, pad, pad, pad);
        scroll.addView(page, new ScrollView.LayoutParams(ScrollView.LayoutParams.MATCH_PARENT, ScrollView.LayoutParams.MATCH_PARENT));

        // A column no wider than a reading line, on a phone turned sideways too.
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        int screen = getResources().getDisplayMetrics().widthPixels - pad * 2;
        page.addView(col, new LinearLayout.LayoutParams(Math.min(screen, dp(420)), LinearLayout.LayoutParams.WRAP_CONTENT));

        // Broken by hand: left to wrap, "files" sat alone on the second line.
        TextView title = text("Keep your boards\nas files", 30, p.ink, Typeface.create(Typeface.SERIF, Typeface.NORMAL));
        title.setLineSpacing(0, 1.05f);
        col.addView(title, gap(0, 14));

        TextView body = text(
            "Each board is saved as its own file, so it shows in Files and stays when the app is uninstalled.",
            16, p.ink2, Typeface.create("sans-serif", Typeface.NORMAL)
        );
        body.setLineSpacing(dp(3), 1f);
        col.addView(body, gap(0, 20));

        // The folder, as a path on a card: what Allow is actually for. The (?)
        // beside it holds how the two buttons work, which most people never need.
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView path = text("Documents / mbrd", 15, p.ink, Typeface.MONOSPACE);
        path.setPadding(dp(16), dp(14), dp(16), dp(14));
        path.setBackground(rounded(p.card, p.rule, dp(12)));
        row.addView(path, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        Button ask = button("?", p.ink2, Color.TRANSPARENT, p.ink);
        ask.setBackground(new RippleDrawable(
            ColorStateList.valueOf((p.ink & 0x00FFFFFF) | 0x24000000), rounded(p.card, p.rule, dp(999)), null));
        ask.setPadding(0, 0, 0, 0);
        ask.setContentDescription("How this works");
        ask.setOnClickListener(v -> help(p));
        LinearLayout.LayoutParams askLp = new LinearLayout.LayoutParams(dp(48), dp(48));
        askLp.leftMargin = dp(10);
        row.addView(ask, askLp);
        col.addView(row, gap(0, 32));

        Button allow = button("Allow access", p.paper, p.ink, p.paper);
        allow.setOnClickListener(v -> allow());
        col.addView(allow, gap(dp(52), 8));

        Button later = button("Not now", p.ink2, Color.TRANSPARENT, p.ink);
        later.setOnClickListener(v -> {
            notNow = true;
            recreate();
        });
        col.addView(later, gap(dp(48), 0));

        setContentView(scroll);
    }

    /** The (?) pop-up: what Allow and Not now each do, on a card of the screen's own paper. */
    private void help(Palette p) {
        if (helpBox != null && helpBox.isShowing()) return;
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(24), dp(24), dp(16));
        box.setBackground(rounded(p.paper, p.rule, dp(20)));

        box.addView(text("How this works", 20, p.ink, Typeface.create(Typeface.SERIF, Typeface.NORMAL)), gap(0, 12));
        Typeface sans = Typeface.create("sans-serif", Typeface.NORMAL);
        TextView allow = text("Allow opens Android's All files access page. Turn mbrd on there, then switch back to mbrd.", 15, p.ink2, sans);
        allow.setLineSpacing(dp(2), 1f);
        box.addView(allow, gap(0, 10));
        TextView later = text("Not now keeps your boards inside the app until the next start, which asks again.", 15, p.ink2, sans);
        later.setLineSpacing(dp(2), 1f);
        box.addView(later, gap(0, 16));

        Dialog dialog = new Dialog(this);
        Button ok = button("Got it", p.ink, Color.TRANSPARENT, p.ink);
        ok.setOnClickListener(v -> dialog.dismiss());
        box.addView(ok, gap(dp(44), 0));

        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setContentView(box);
        Window w = dialog.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            int width = Math.min(getResources().getDisplayMetrics().widthPixels - dp(48), dp(380));
            w.setLayout(width, WindowManager.LayoutParams.WRAP_CONTENT);
        }
        helpBox = dialog;
        dialog.show();
    }

    /** tokens.css's default palette, light and dark. */
    private enum Palette {
        LIGHT(PAPER, 0xFFFDFDFA, INK, 0xFF615141, 0xFF968371, 0xFFDAD7CD),
        DARK(0xFF211914, 0xFF2C241E, 0xFFF4E5D7, 0xFFCFBCAA, 0xFFA38F7D, 0xFF4E463F);

        final int paper, card, ink, ink2, ink3, rule;

        Palette(int paper, int card, int ink, int ink2, int ink3, int rule) {
            this.paper = paper;
            this.card = card;
            this.ink = ink;
            this.ink2 = ink2;
            this.ink3 = ink3;
            this.rule = rule;
        }
    }

    private TextView text(String s, int sp, int color, Typeface face) {
        TextView view = new TextView(this);
        view.setText(s);
        view.setTextColor(color);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        view.setTypeface(face);
        return view;
    }

    /** A pill with a ripple, without Material's caps, tint or raised shadow. */
    private Button button(String label, int fg, int bg, int ripple) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(fg);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        b.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        b.setStateListAnimator(null);
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        b.setBackgroundTintList(null);
        GradientDrawable mask = new GradientDrawable();
        mask.setCornerRadius(dp(999));
        mask.setColor(Color.WHITE);
        GradientDrawable fill = new GradientDrawable();
        fill.setCornerRadius(dp(999));
        fill.setColor(bg);
        int wash = (ripple & 0x00FFFFFF) | 0x24000000;
        b.setBackground(new RippleDrawable(ColorStateList.valueOf(wash), fill, mask));
        return b;
    }

    private GradientDrawable rounded(int fill, int stroke, int radius) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setStroke(Math.max(1, dp(1)), stroke);
        d.setCornerRadius(radius);
        return d;
    }

    /** Full width, `height` px (0 for wrap), and `belowDp` of space under it. */
    private LinearLayout.LayoutParams gap(int height, int belowDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            height > 0 ? height : LinearLayout.LayoutParams.WRAP_CONTENT
        );
        lp.bottomMargin = dp(belowDp);
        return lp;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
