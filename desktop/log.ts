// Append-only log file for the desktop shell. Every catch in desktop/ writes
// here; Help → Show logs opens the folder. No crash reporter, no upload.
// One file, rotated once at 1 MB (previous run survives as main.1.log).
// Must never throw — every caller is itself a catch handler.

import { app } from 'electron';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 1024 * 1024;

export type LogLevel = 'info' | 'warn' | 'error';

let file: string | null = null;
let dir: string | null = null;

/** Null before `ready` — userData is not settled until then. */
export function logDir(): string | null {
  return dir;
}

/** Called once after `ready` and any userData move. */
export function initLog(): void {
  try {
    dir = join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    file = join(dir, 'main.log');
    log('info', 'log opened', { version: app.getVersion(), packaged: app.isPackaged });
  } catch {
    file = null;
  }
}

/** One line, appended. Safe before initLog(), where it does nothing. */
export function log(level: LogLevel, message: string, detail?: unknown): void {
  if (!file) return;
  try {
    rotate();
    const at = new Date().toISOString();
    // JSON so a multi-line stack stays on one line (grep-friendly).
    const extra = detail === undefined ? '' : ' ' + safeJson(detail);
    appendFileSync(file, `${at} ${level.toUpperCase()} ${message}${extra}\n`);
  } catch {
    // Must not throw — callers are already in a catch.
  }
}

/** An Error, a string, or something nobody thought about, as one line. */
function safeJson(value: unknown): string {
  try {
    if (value instanceof Error) {
      return JSON.stringify({ name: value.name, message: value.message, stack: value.stack });
    }
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function rotate(): void {
  if (!file) return;
  try {
    if (statSync(file).size < MAX_BYTES) return;
    renameSync(file, file.replace(/\.log$/, '.1.log'));
  } catch {
    // Missing file (first write) or failed rename — both harmless.
  }
}
