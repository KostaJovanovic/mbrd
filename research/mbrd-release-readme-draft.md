# mbrd

A moodboard. Drop in images, video, audio, 3D models, notes and links, arrange
them on a board with no edges, and save the whole board as one `.mbrd` file.
There is no account, and nothing is uploaded.

This page has the apps. mbrd also runs in a browser at
[mbrd.valjdakosta.com](https://mbrd.valjdakosta.com), with nothing to install.

## Download

Open the [latest release](https://github.com/KostaJovanovic/mbrd-release/releases/latest)
and take the file for your system.

| System | File |
|---|---|
| Windows | `mbrd-Windows-<version>.exe` |
| macOS, Apple silicon and Intel | `mbrd-mac-universal-<version>.dmg` |
| Linux, x64 | `mbrd-linux-x64-<version>.AppImage` |
| Android 7 and later | `mbrd-android-<version>.apk` |

`mbrd-source-<version>.zip` is the source code of that release. You do not need
it to run mbrd.

## Install

The apps do not have a paid signing certificate yet, so each system warns you
once.

- **Windows:** run the file. If SmartScreen stops it, click **More info**, then
  **Run anyway**. The first page asks how you want mbrd:
  - **Install** puts it in your user account, with a Start menu entry.
  - **Portable** puts it in a folder you choose, with its data in the same
    folder. It changes nothing else on the computer.
- **macOS:** open the `.dmg` and drag mbrd to Applications. Open mbrd once and
  close the warning. Then open **System Settings > Privacy & Security** and
  click **Open Anyway**.
- **Linux:** make the file executable with `chmod +x`, then run it.
- **Android:** open the `.apk`. When Android asks, let your browser or file
  manager install apps.

On Windows, macOS and Linux, each board is a `.mbrd` file in `Documents/mbrd`.
A portable copy keeps its boards in its own folder.

## Updates

mbrd checks for a new version once a day.

- **Windows (installed):** the new version downloads in the background, and an
  **Update** button shows in the title bar. The update installs when you quit,
  or at once if you choose **Restart now**.
- **Linux:** the new AppImage takes the place of the old one.
- **Windows portable and macOS:** mbrd tells you about the new version. Download
  the new file from this page yourself.
- **Android:** the new version downloads in the background, and an **Update**
  row shows in the side panel. With Data Saver on a metered network, it
  downloads only when you press the row.

Before a download installs, mbrd compares it with the checksum that GitHub
publishes for it. Your boards stay where they are.

## Licence

GPL-3.0-or-later. The source code of each release is in the release, as
`mbrd-source-<version>.zip`.
