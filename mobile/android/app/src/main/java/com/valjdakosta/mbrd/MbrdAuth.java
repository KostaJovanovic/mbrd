package com.valjdakosta.mbrd;

import android.app.Activity;
import android.app.PendingIntent;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationClient;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;

import java.util.Collections;

/**
 * Google Drive's sign-in for the Android app, through Google's Authorization
 * API: Android's own account sheet, and then an access token for the page.
 * The web's popup cannot work here, because the app serves https://app and
 * Google knows nothing of it.
 *
 * Google finds the OAuth client by the package name and the SHA-1 of the key
 * that signed the APK, so there is no client id in this file. Until that
 * client exists in the maintainer's Google Cloud console, Google answers with
 * an error, and config.ts's GOOGLE_ANDROID_CLIENT keeps the Drive rows off.
 *
 * The one scope is drive.file, checked here and not only in the page.
 */
@CapacitorPlugin(name = "MbrdAuth")
public class MbrdAuth extends Plugin {

    private static final String DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";

    /** Google does not say how long this token lasts. Its access tokens last
     *  an hour, and the page asks again a little before that. */
    private static final int EXPIRES_IN = 55 * 60;

    private ActivityResultLauncher<IntentSenderRequest> consent;
    /** The sign-in waiting on the consent screen. One at a time. */
    private PluginCall pending;

    @Override
    public void load() {
        // In load(), which runs inside the activity's onCreate: a launcher
        // registered after the activity has started throws.
        consent = getActivity().registerForActivityResult(
            new ActivityResultContracts.StartIntentSenderForResult(), this::consented);
    }

    @PluginMethod
    public void google(PluginCall call) {
        if (!DRIVE_FILE.equals(call.getString("scope"))) {
            call.reject("the sign-in asks for a scope mbrd does not use");
            return;
        }
        if (pending != null) {
            call.reject("a sign-in is already open");
            return;
        }
        AuthorizationRequest request = AuthorizationRequest.builder()
            .setRequestedScopes(Collections.singletonList(new Scope(DRIVE_FILE)))
            .build();
        client().authorize(request)
            .addOnSuccessListener(result -> {
                if (!result.hasResolution()) {
                    answer(call, result);
                    return;
                }
                // The account has not granted the scope yet: Google's own
                // screens ask, and consented() reads what they answered.
                PendingIntent ask = result.getPendingIntent();
                if (ask == null) {
                    call.reject("Google asked for a step it did not give");
                    return;
                }
                pending = call;
                consent.launch(new IntentSenderRequest.Builder(ask.getIntentSender()).build());
            })
            .addOnFailureListener(e -> call.reject("Google refused the sign-in: " + e.getMessage()));
    }

    private void consented(ActivityResult result) {
        PluginCall call = pending;
        pending = null;
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("Google Drive access was not granted");
            return;
        }
        try {
            answer(call, client().getAuthorizationResultFromIntent(result.getData()));
        } catch (ApiException e) {
            call.reject("Google refused the sign-in: " + e.getStatusCode());
        }
    }

    private AuthorizationClient client() {
        return Identity.getAuthorizationClient(getActivity());
    }

    private static void answer(PluginCall call, AuthorizationResult result) {
        String token = result.getAccessToken();
        if (token == null || token.isEmpty()) {
            call.reject("Google did not return a usable token");
            return;
        }
        JSObject out = new JSObject();
        out.put("token", token);
        out.put("expiresIn", EXPIRES_IN);
        call.resolve(out);
    }
}
