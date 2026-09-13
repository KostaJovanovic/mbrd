# mbrd for Android

The Android shell: Capacitor around the same `web/` tree the website serves.
For now this file holds the release key (group O of
`research/apps-tasks-2026-09-13.md`). Group P writes the rest.

## The release key

The maintainer does this once, before the first release with an APK. The
release workflow (`.github/workflows/release.yml`) signs the APK with the key
from the repository secrets. `build.gradle` signs with it only when
`MBRD_KEYSTORE` names the file, so a local build does not change.

**Never replace the key once a release is out.** Android refuses an update
signed with another key, so a new key strands every installed copy.

1. Make the key with the `keytool` of JDK 21. It asks for a password, then for
   a name, which the certificate shows:

   ```
   keytool -genkeypair -v -keystore mbrd-release.jks -alias mbrd -keyalg RSA -keysize 4096 -validity 36500
   ```

2. Turn the file into one line of base64.

   On Windows, in PowerShell:

   ```
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\mbrd-release.jks")) | Set-Content -NoNewline mbrd-release.b64
   ```

   On Linux:

   ```
   base64 -w0 mbrd-release.jks > mbrd-release.b64
   ```

3. Set the secrets on `KostaJovanovic/mbrd`, the private source repository,
   where the workflow runs. The second command asks for the password.

   On Windows, in PowerShell:

   ```
   Get-Content -Raw mbrd-release.b64 | gh secret set ANDROID_KEYSTORE_BASE64 -R KostaJovanovic/mbrd
   gh secret set ANDROID_KEYSTORE_PASSWORD -R KostaJovanovic/mbrd
   gh secret set ANDROID_KEY_ALIAS -R KostaJovanovic/mbrd --body mbrd
   ```

   On Linux, the first line is
   `gh secret set ANDROID_KEYSTORE_BASE64 -R KostaJovanovic/mbrd < mbrd-release.b64`.

4. Delete `mbrd-release.b64`. Keep `mbrd-release.jks` and its password offline,
   in two places.

`ANDROID_KEY_PASSWORD` is only for a key with a password of its own.
`keytool` writes a PKCS12 store, which has one password for the store and the
key, so this key needs none.
