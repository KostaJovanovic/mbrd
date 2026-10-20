// The bridge: named functions on window.mbrdDesktop via contextBridge.
// Never expose ipcRenderer directly. Main re-validates every argument.
// CJS because Electron cannot run an ESM preload under sandbox:true.
// Each on* callback keeps only the last listener (one renderer, one boot).

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
   *
   * 3: `win` and `platform` went when the title bar left the page. The bar is
   * its own web contents now (chrome/), and nothing in the board reads either.
   */
  bridge: 3,

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
    append: (path: string, data: ArrayBuffer, at: number) => invoke('files:append', path, data, at),
    tail: (path: string, length: number) => invoke('files:tail', path, length),
    read: (path: string) => invoke('files:read', path),
    exists: (path: string) => invoke('files:exists', path),
    // The shelf's "Earlier versions": the rolling copies of one board, newest first.
    versions: (path: string) => invoke('files:versions', path),
  },

  // The boards folder (boards.ts): Documents/mbrd, where every board is a file.
  boards: {
    list: () => invoke('boards:list'),
    create: (suggested: string, data: ArrayBuffer) => invoke('boards:create', suggested, data),
    rename: (path: string, suggested: string) => invoke('boards:rename', path, suggested),
    trash: (path: string) => invoke('boards:trash', path),
    reveal: () => invoke('boards:reveal'),
  },

  native: {
    can: () => invoke('native:can'),
    firstFrame: (bytes: ArrayBuffer) => invoke('native:firstFrame', bytes),
    transcode: (bytes: ArrayBuffer, opts: unknown) => invoke('native:transcode', bytes, opts),
    matte: (input: Float32Array) => invoke('native:matte', input),
    decode: (bytes: ArrayBuffer, name: string) => invoke('native:decode', bytes, name),
  },

  // A request with no answer: the shell replies on the title bar's Update button.
  updates: {
    check: () => invoke('updates:check'),
    // The title bar's Update button offers the desktop's updates (updates.ts),
    // so the page is never told of one. Install checks, downloads and restarts
    // into one at once, with every answer on the button (updates.updateNow()).
    onOffer: () => {},
    install: () => invoke('updates:install'),
    // The panel's "Check for updates automatically"; Help's check runs either way.
    auto: (on: boolean) => invoke('updates:auto', on),
  },

  // Google Drive's sign-in, which main runs in the system browser.
  auth: {
    google: (req: unknown) => invoke('auth:google', req),
  },

  // The benchmark (web/assets/js/perf/bench.ts): a result into bench/ in the
  // boards folder. No frames: the desktop's rAF is paced by presented frames.
  bench: {
    save: (name: string, json: string) => invoke('bench:save', name, json),
    frames: null,
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
