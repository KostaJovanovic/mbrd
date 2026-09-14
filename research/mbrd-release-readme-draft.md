# mbrd

Release builds of mbrd, a local-first moodboard. Web version:
[mbrd.valjdakosta.com](https://mbrd.valjdakosta.com).

## Files

From the [latest release](https://github.com/KostaJovanovic/mbrd-release/releases/latest):

| Platform | File | Updates |
|---|---|---|
| Windows x64 | `mbrd-Windows-<v>.exe` | automatic (portable: manual) |
| macOS universal | `mbrd-mac-universal-<v>.dmg` | manual |
| Linux x64 | `mbrd-linux-x64-<v>.AppImage` | automatic |
| Android 7+ | `mbrd-android-<v>.apk` | automatic |
| Source | `mbrd-source-<v>.zip` | — |

The Windows installer can also set up a portable copy (a single folder with its data).

## Unsigned builds

- Windows: SmartScreen > **More info** > **Run anyway**.
- macOS: open once, then **System Settings > Privacy & Security > Open Anyway**.
- Linux: `chmod +x mbrd-linux-x64-*.AppImage`.
- Android: allow installs from the browser or file manager.

## Notes

- Boards are `.mbrd` files in `Documents/mbrd` (portable copy: in its own folder).
- Update checks run daily against this repo's latest release. Downloads are
  verified against GitHub's SHA-256 digest before they install.

GPL-3.0-or-later.
