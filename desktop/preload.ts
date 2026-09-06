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
//   argument again on its own side - a path is only honoured if that process
//   produced it, see desktop/files.ts - because this file runs in the
//   renderer's process and a compromised renderer would own it. The value of
//   the boundary is that main does not trust what arrives.
//
// ── Why this file is CommonJS ──
//
// The build emits CJS for both bundles, and for the preload it is not optional:
// Electron does not run an ESM preload script under `sandbox: true`, and the
// failure is a window that loads with no bridge at all rather than an error
// anybody sees. `sandbox: true` is the decision; the format follows it.
//
// ── The two callbacks ──
//
// `onClose` and `onOpenFiles` are the only inbound direction. Both take one
// listener and keep the last one, rather than adding to a list: there is one
// renderer, it registers once at boot, and a set of them would be a leak with
// no way to notice. `closeNow` is not exposed separately - the close handler
// answers by resolving, which is what makes it impossible to forget.

import { contextBridge, ipcRenderer } from 'electron';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('mbrdDesktop', {
  /**
   * The bridge's own version, not the app's.
   *
   * The shape of this object is written twice - here, and as `Bridge` in
   * platform/electron.ts - because the two live in packages with different
   * tsconfigs and a web module may not import Node's types. This number is what
   * catches the two drifting: bumped when something is removed or changes
   * shape, so an adapter can refuse a shell older than it expects rather than
   * calling a function that is not there.
   */
  bridge: 1,

  store: {
    get: (store: string, key: string) => invoke('store:get', store, key),
    set: (store: string, key: string, value: unknown) => invoke('store:set', store, key, value),
    del: (store: string, key: string) => invoke('store:del', store, key),
    keys: (store: string) => invoke('store:keys', store),
    clear: (store: string) => invoke('store:clear', store),
    getMany: (store: string, keys: string[]) => invoke('store:getMany', store, keys),
    setMany: (store: string, entries: [string, unknown][]) => invoke('store:setMany', store, entries),
    delMany: (store: string, keys: string[]) => invoke('store:delMany', store, keys),
  },

  files: {
    pickOpen: () => invoke('files:pickOpen'),
    pickSave: (suggested: string) => invoke('files:pickSave', suggested),
    pickImport: () => invoke('files:pickImport'),
    write: (path: string, data: ArrayBuffer) => invoke('files:write', path, data),
    read: (path: string) => invoke('files:read', path),
    exists: (path: string) => invoke('files:exists', path),
  },

  native: {
    can: () => invoke('native:can'),
    firstFrame: (bytes: ArrayBuffer) => invoke('native:firstFrame', bytes),
    transcode: (bytes: ArrayBuffer, opts: unknown) => invoke('native:transcode', bytes, opts),
    matte: (input: Float32Array) => invoke('native:matte', input),
    decode: (bytes: ArrayBuffer, name: string) => invoke('native:decode', bytes, name),
  },

  startupNotes: () => invoke('app:startupNotes'),

  setDocument: (state: unknown) => ipcRenderer.send('app:document', state),

  relaunch: () => ipcRenderer.send('app:relaunch'),

  onCommand: (fn: (cmd: string) => void) => {
    ipcRenderer.removeAllListeners('app:command');
    ipcRenderer.on('app:command', (_event, cmd: string) => fn(cmd));
  },

  onClose: (fn: () => Promise<void>) => {
    // One listener, replaced rather than added to. The answer is sent back on
    // its own channel rather than returned, because main is waiting on a
    // window close it has already prevented - there is no invoke to resolve.
    ipcRenderer.removeAllListeners('app:close-requested');
    ipcRenderer.on('app:close-requested', () => {
      // Settled either way. A close the page refuses to acknowledge would be a
      // window that cannot be shut, which is worse than a lost autosave - main
      // has its own ceiling for that case and this is the half that keeps it
      // from being reached in the ordinary one.
      fn().then(() => ipcRenderer.send('app:close-now'), () => ipcRenderer.send('app:close-now'));
    });
  },

  onOpenFiles: (fn: (files: unknown[]) => void) => {
    ipcRenderer.removeAllListeners('app:open-files');
    ipcRenderer.on('app:open-files', (_event, files: unknown[]) => fn(files));
  },
});
