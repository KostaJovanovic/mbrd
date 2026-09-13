package com.valjdakosta.mbrd;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.core.app.ActivityCompat;
import com.getcapacitor.BridgeActivity;

/**
 * The one activity: Capacitor's BridgeActivity with the shell's plugins, and the
 * question of where the boards live. Desktop twin: the BrowserWindow that
 * desktop/main.ts opens, and its choice of a data folder.
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Before super.onCreate(): the bridge is built there, and a plugin
        // registered afterwards is never loaded.
        registerPlugin(MbrdShell.class);
        registerPlugin(MbrdStore.class);
        registerPlugin(MbrdFiles.class);
        super.onCreate(savedInstanceState);
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

    @Override
    public void onResume() {
        super.onResume();
        if (inSettings && bridge == null) {
            inSettings = false;
            // Back from Android's page. Without the grant the screen stays, and
            // Not now is still there.
            if (MbrdRoot.granted(this)) recreate();
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
