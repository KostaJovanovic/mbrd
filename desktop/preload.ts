// The bridge, and the only thing the page can see of this process.
//
// One object of named functions on `window.mbrdDesktop`, exposed through
// contextBridge. Two rules hold for everything that is ever added here:
//
//   **Never expose ipcRenderer.** Handing the page the port hands it every
//   channel main listens on, forever, including the ones added next year. What
//   goes across is a function per thing the app can ask, and the list of things
//   it can ask is readable in one screen.
//
//   **A function here is a request, not a capability.** Main validates every
//   argument again on its own side - see main.ts's note about paths - because
//   this file runs in the renderer's process and a compromised renderer would
//   own it. The value of the boundary is that main does not trust what arrives.
//
// ── Why this file is CommonJS ──
//
// The build emits CJS for both bundles, and for the preload it is not optional:
// Electron does not run an ESM preload script under `sandbox: true`, and the
// failure is a window that loads with no bridge at all rather than an error
// anybody sees. `sandbox: true` is the decision; the format follows it.
//
// ── What is here now ──
//
// A version, and nothing else. The window loading and the app booting over
// `app://` is the whole of group D, and every later group adds its functions
// beside this one with a matching `ipcMain.handle` in main.ts. The page reads
// this global in exactly one place - main.ts's bridge check - and hands it to
// electronPlatform() as an argument, so nothing below that line knows this file
// exists.

import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('mbrdDesktop', {
  /**
   * The bridge's own version, not the app's.
   *
   * It is here so the renderer has something to test that is not "did this
   * object exist", and so a future adapter can refuse a shell older than it
   * expects rather than calling a function that is not there. One number,
   * bumped when something is removed or changes shape.
   */
  bridge: 1,
});
