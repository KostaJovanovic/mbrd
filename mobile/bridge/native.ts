// Calls into the shell's Java plugins through Capacitor's own bridge, which is
// JSON: fit for names and flags, never for bytes (bytes.ts moves those).
// Capacitor's native-bridge.js defines window.Capacitor at document start, after
// this bundle, so it is looked up at each call and never at load.

interface CapacitorGlobal {
  nativePromise(plugin: string, method: string, options: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface Window {
    Capacitor?: CapacitorGlobal;
  }
}

/** One plugin method. `T` is the object that method resolves, as its Java builds it. */
export function call<T>(plugin: string, method: string, options: Record<string, unknown> = {}): Promise<T> {
  const cap = window.Capacitor;
  if (typeof cap?.nativePromise !== 'function') {
    return Promise.reject(new Error('the Capacitor bridge is not ready'));
  }
  // SAFETY: the value is the JSObject the named Java method resolves, and each
  // caller names its shape with every field optional or checked.
  return cap.nativePromise(plugin, method, options) as Promise<T>;
}
