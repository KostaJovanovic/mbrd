// A log file, because an unsigned build on somebody else's machine has no
// console.
//
// The web app never needed one: a visitor with a problem has DevTools one
// keystroke away and the console is right there. A tester running a downloaded
// installer has neither - the window opens or it does not, and "it did not
// work" is the whole of the report. So every catch in desktop/ writes a line
// here, and Help → Show logs opens the folder.
//
// ── Not a crash reporter ──
//
// There is no crashReporter and no upload. This app has no server, which is the
// architecture and not an omission, and a build that quietly posted stack traces
// somewhere would be the first thing in the tree to phone home. The file is on
// the person's own disk and they send it if they want to.
//
// ── One file, rotated once ──
//
// A log that grows without limit is a disk-filling bug wearing a diagnostic's
// clothes, and a log that rotates ten times is a directory nobody reads. One
// megabyte is a few thousand lines, which is more than any one session
// produces; the previous run's file survives as main.1.log, which is the one
// case that actually matters - the session that went wrong is usually the one
// before the person thought to look.
//
// ── It must never throw ──
//
// Every caller is a `catch`. A logger that failed inside the handling of a
// failure would replace a diagnosable problem with an undiagnosable one, so
// every operation here is wrapped and a logger that cannot write is silently a
// no-op. That is the same bargain notify.ts takes on the web: saying something
// to a person who is not there is not an error.

import { app } from 'electron';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 1024 * 1024;

export type LogLevel = 'info' | 'warn' | 'error';

let file: string | null = null;
let dir: string | null = null;

/**
 * Where the logs are. Null before `ready`, because userData is not settled
 * until then - and on a portable copy it moves, which is exactly the sort of
 * thing worth having logged correctly.
 */
export function logDir(): string | null {
  return dir;
}

/**
 * Open the log. Called once, after `ready` and after any userData move.
 *
 * Separate from the first write so that the directory is made once rather than
 * checked on every line, and so a portable build that failed to claim its own
 * data folder logs to wherever it actually ended up rather than to where it
 * meant to.
 */
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
    // Detail is JSON so a line stays a line - a stack trace spread over twenty
    // of them is what makes a log file unreadable by grep, which is the only
    // way anybody reads one.
    const extra = detail === undefined ? '' : ' ' + safeJson(detail);
    appendFileSync(file, `${at} ${level.toUpperCase()} ${message}${extra}\n`);
  } catch {
    // See the header: a logger that throws inside a catch is worse than no
    // logger at all.
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
    // A missing file is the ordinary case on the first write, and a rename that
    // fails leaves an oversized log rather than losing one - both better than
    // refusing to log.
  }
}
