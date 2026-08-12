#!/usr/bin/env python3
"""Local dev server for mbrd.

`python -m http.server` is almost enough, but not quite: it serves whatever
directory it is launched from, it 404s any path that is not a literal file, and
it serialises requests - which deadlocks the service worker's background
revalidation fetches. This does the three things that matter:

  /                    -> web/index.html
  /assets/...          -> served literally from web/, when the file is there
  /name                -> web/name.html, when that file is there
  /anything-else       -> web/index.html, with a **404 status** (_serve_notfound)

The last line is the whole not-found design and not a fallback: there is no
separate error page, the app is its own, and main.js works out that it is not at
home by looking at the URL. The status stays a 404 because that is what a crawler
reads - handing index.html back with a 200 is a soft 404, a page that says "not
found" while swearing it is fine. A static host is asked for the same thing with
web/404.html, a byte copy of index.html (see wrangler.jsonc).

It binds 0.0.0.0 and prints a scannable QR for the LAN URL, so a phone on the
same Wi-Fi can open the board without typing an IP.

Run: python tools/serve.py [port] [lan-ip]  (defaults to 6273; server.bat passes both)
"""
import os
import socket
import sys
import urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

# The QR encoder lives beside this file rather than inside it - see qr.py.
from qr import qr_terminal

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 6273
# serve.py lives in tools/ but its document root is the repo's web/, so paths
# match what a static host would serve. Resolved from __file__, not the working
# directory, so the launch directory never matters.
ROOT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'web')

# .mbrd is a renamed ZIP; without this the dev server would hand it back as
# text/plain and a fetch/drop round-trip would look subtly broken.
EXTRA_TYPES = {
    '.mbrd': 'application/vnd.mbrd+zip',
    '.webmanifest': 'application/manifest+json',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
}


class BoardHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **EXTRA_TYPES}

    @staticmethod
    def _inside_root(candidate):
        """Whether a joined path still resolves under the document root.

        normcase as well as realpath: on Windows the same directory can be
        spelled in several cases and commonpath compares strings.

        commonpath belongs inside the guard, not after it: on Windows it raises
        ValueError when the two paths sit on different drives, and a request for
        "/D:/outside" against a repo on C: produces exactly that pair. Raising
        here kills the handler and the client sees a dropped connection instead
        of the 404 this is meant to produce. Every failure to place the path is
        the same answer - not inside the root.
        """
        try:
            root = os.path.normcase(os.path.realpath(ROOT))
            full = os.path.normcase(os.path.realpath(candidate))
            return full == root or os.path.commonpath([root, full]) == root
        except (OSError, ValueError):
            return False

    def _route(self):
        """Map the request path to a file, or set self._not_found."""
        self._not_found = False
        raw = self.path.split('?', 1)[0].split('#', 1)[0]
        # Decode percent-escapes before touching the filesystem: an asset whose
        # name contains a space must match the on-disk file, not "...%20...".
        path = urllib.parse.unquote(raw)

        if path in ('/', ''):
            return '/index.html'

        rel = path.lstrip('/')
        full = os.path.join(ROOT, rel)
        # Resolved before it is probed, not after. SimpleHTTPRequestHandler
        # normalises the path it actually serves, so nothing was reachable
        # through this - but the probe above it was still asking the filesystem
        # about a path built by joining ROOT to whatever arrived, and "does this
        # exist" is a question worth only asking inside the document root.
        if not self._inside_root(full):
            self._not_found = True
            return '/index.html'
        if os.path.isfile(full):
            # Hand back the still-encoded path so the base handler unquotes it
            # exactly once, as it normally would.
            return raw
        if os.path.isfile(full + '.html'):
            return '/' + rel + '.html'
        # Everything left is an address the app does not have, and every one of
        # them gets the app itself with a 404 status. That is the whole of the
        # not-found design: there is no separate error page any more, the app is
        # it, and main.js works out that it is not at home by looking at the URL
        # (see notFound there). The status still has to be a 404 - it is what
        # keeps a dead address out of a search index, and what the browser and
        # every crawler actually read.
        #
        # No SPA-route branch above this. The app has no path routes: it lives
        # at / and says everything else in the hash, so an extensionless path
        # that is not a file is a miss like any other. It used to be handed
        # index.html with a 200, which is a soft 404 - a page that says "not
        # found" while swearing it is fine.
        self._not_found = True
        return '/index.html'

    def _serve_notfound(self):
        """The app, at an address it does not have, with the status that says so.

        Body and status are decoupled here on purpose: the document is the same
        index.html the root serves, and the only difference a miss makes is the
        404 in the status line. A static host cannot decouple the two and is
        handed web/404.html instead, which is that same document copied byte for
        byte (see wrangler.jsonc, and save.bat which makes the copy).
        """
        try:
            with open(os.path.join(ROOT, 'index.html'), 'rb') as f:
                body = f.read()
        except OSError:
            self.send_error(404)
            return
        self.send_response(404)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def end_headers(self):
        # Local dev only: forbid heuristic caching so a single refresh always
        # shows the latest edit - including modules pulled by a later import().
        # 'no-cache' still allows a stored copy plus revalidation (-> 304), so it
        # stays fast. The service worker disables itself on localhost/LAN too.
        if not getattr(self, '_cc_set', False):
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
            self._cc_set = True
        super().end_headers()

    def do_GET(self):
        target = self._route()
        if self._not_found:
            return self._serve_notfound()
        self.path = target
        return super().do_GET()

    def do_HEAD(self):
        target = self._route()
        if self._not_found:
            return self._serve_notfound()
        self.path = target
        return super().do_HEAD()

    # A hard reload aborts in-flight requests the browser no longer needs. On
    # Windows that surfaces as ConnectionAborted/Reset/BrokenPipe mid-write,
    # which otherwise prints an alarming traceback and - with the service worker
    # firing concurrent fetches - could take the dev server down. The client is
    # gone: there is nothing to send and nothing to report.
    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            self.close_connection = True

    def copyfile(self, source, outputfile):
        try:
            super().copyfile(source, outputfile)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass

    def log_error(self, fmt, *args):
        # Aborted connections are the noise this exists to hide: a phone
        # locking its screen mid-request produces a burst of "Bad request
        # version" lines that mean nothing. Everything else is a real fault in
        # a handler or a genuinely malformed request, and swallowing those made
        # a broken route look like a silent one - which is precisely the thing
        # a development server is for.
        try:
            message = fmt % args
        except Exception:
            message = str(fmt)
        if 'Bad request' in message or 'Request timed out' in message:
            return
        super().log_error('%s', message)


def _lan_ip():
    """Best-guess LAN IPv4 (the address a phone on the same Wi-Fi would use)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))   # no packets sent; just picks the route's src IP
        return s.getsockname()[0]
    except OSError:
        return '127.0.0.1'
    finally:
        s.close()


def _print_startup_qr(port):
    # argv[2] lets server.bat pass the IP it already found; otherwise detect it.
    ip = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else _lan_ip()
    url = 'http://%s:%d' % (ip, port)
    if os.name == 'nt':
        # Enable ANSI colours in the classic console (Windows Terminal already has
        # them); without this the escape codes would print as raw text.
        try:
            import ctypes
            k = ctypes.windll.kernel32
            k.SetConsoleMode(k.GetStdHandle(-11), 7)
        except Exception:
            pass
    try:
        print(qr_terminal(url))
    except Exception:
        pass  # never let the QR stop the server from starting
    print('  Scan the QR (same Wi-Fi) or open  %s\n' % url)


def _die_on_console_close():
    """Exit immediately when the console window is closed/logged off/shut down.

    Without this, closing the "mbrd server" window (the X button, not
    Ctrl+C) doesn't reliably kill a ThreadingHTTPServer in time - it can be
    left holding PORT, so the *next* server.bat launch fails to bind. That's
    also why server.bat pre-kills whatever's still on the port; this makes
    that workaround unnecessary in the common case by shutting down the
    instant Windows signals the close."""
    if os.name != 'nt':
        return
    import ctypes

    CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT = 2, 5, 6

    @ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_uint)
    def _handler(event):
        if event in (CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT):
            os._exit(0)
        return 0

    ctypes.windll.kernel32.SetConsoleCtrlHandler(_handler, True)
    _die_on_console_close._handler = _handler  # keep the ctypes callback alive


if __name__ == '__main__':
    _die_on_console_close()
    _print_startup_qr(PORT)
    os.chdir(ROOT)
    # ThreadingHTTPServer (not HTTPServer): the service worker fires background
    # revalidation fetches (stale-while-revalidate) concurrently with the page's
    # own requests. A single-threaded server serialises those and can deadlock -
    # the SW's navigation fetch never resolves, so the page "loads" forever with
    # nothing in the console. One thread per request avoids it.
    httpd = ThreadingHTTPServer(('0.0.0.0', PORT), BoardHandler)
    print('Serving %s on http://0.0.0.0:%d' % (ROOT, PORT))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.server_close()
