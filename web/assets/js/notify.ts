// Toast and busy-bar, callable from layers below the UI.
// Unwired (test, worker, pre-boot): every call is a safe no-op.
// No DOM here — ui/overlays.ts owns the rendering. main.ts wires via setOverlays().

import { cue } from './cuelume/engine.ts';

export type ToastKind = '' | 'error';

export interface BusyJob {
  label(text: string): void;
  step(done: number, total: number): void;
  end(): void;
}

export interface BusyOptions {
  onCancel?: (() => void) | null;
}

export interface Overlays {
  toast(msg: string, kind?: ToastKind): void;
  busy(label?: string, opts?: BusyOptions): BusyJob;
}

const NOWHERE: BusyJob = Object.freeze({
  label(): void {},
  step(): void {},
  end(): void {},
});

let overlays: Overlays | null = null;

export function setOverlays(impl: Overlays | null): void {
  overlays = impl;
}

export function toast(msg: string, kind: ToastKind = ''): void {
  overlays?.toast(msg, kind);
  cue(kind === 'error' ? 'fail' : 'note');
}

// Once-per-reason toast when a preview (PDF page, video frame, etc.) fails.
const saidNoPreview = new Set<string>();

export function noPreview(subject: string, why: unknown): void {
  const message = why instanceof Error ? why.message : String(why ?? '');
  const reason = message.trim().slice(0, 100) || 'no reason given';
  if (saidNoPreview.has(reason)) return;
  saidNoPreview.add(reason);
  toast(`No ${subject} preview - ${reason}`, 'error');
}

// Firefox strict mode / Safari Lockdown silently blank canvas reads.
let saidCanvasBlocked = false;

export function canvasBlocked(): void {
  if (saidCanvasBlocked) return;
  saidCanvasBlocked = true;
  toast('This browser is blocking canvas reads for this site, so previews cannot be made - '
    + 'turn off strict tracking protection here and reload', 'error');
}

// Catch async command rejections and toast them. Sync throws are left for the console.
export function runCommand(result: unknown, what = 'That'): void {
  if (typeof (result as { then?: unknown } | null)?.then !== 'function') return;
  (result as Promise<unknown>).catch((err: unknown) => {
    console.warn('[mbrd] command failed', err);
    toast(`${what} did not work`, 'error');
  });
}

export function busy(label = 'Working', opts: BusyOptions = {}): BusyJob {
  return overlays?.busy(label, opts) ?? NOWHERE;
}
