package com.valjdakosta.mbrd;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * The one activity: Capacitor's BridgeActivity with the shell's plugin. Desktop
 * twin: the BrowserWindow that desktop/main.ts opens.
 */
public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Before super.onCreate(): the bridge is built there, and a plugin
        // registered afterwards is never loaded.
        registerPlugin(MbrdShell.class);
        super.onCreate(savedInstanceState);
    }
}
