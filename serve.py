#!/usr/bin/env python3
"""Local dev server for mbrd.

`python -m http.server` is almost enough, but not quite: it serves whatever
directory it is launched from, it 404s any path that is not a literal file, and
it serialises requests - which deadlocks the service worker's background
revalidation fetches. This does the three things that matter:

  /                    -> web/index.html
  /assets/...          -> served literally from web/
  /anything-else       -> web/index.html (SPA fallback), or 404.html for a
                          request that clearly wanted a real file (has an
                          extension)

It binds 0.0.0.0 and prints a scannable QR for the LAN URL, so a phone on the
same Wi-Fi can open the board without typing an IP.

Run: python serve.py [port] [lan-ip]   (defaults to 6273; server.bat passes both)
"""
import os
import socket
import sys
import urllib.parse
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 6273
# serve.py lives in the repo root but its document root is web/, so paths match
# what a static host would serve.
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web')

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
        if os.path.isfile(full):
            # Hand back the still-encoded path so the base handler unquotes it
            # exactly once, as it normally would.
            return raw
        if os.path.isfile(full + '.html'):
            return '/' + rel + '.html'
        if os.path.splitext(rel)[1]:
            self._not_found = True      # wanted a real file: a 404 is the truth
            return '/404.html'
        return '/index.html'            # SPA route

    def _serve_notfound(self):
        try:
            with open(os.path.join(ROOT, '404.html'), 'rb') as f:
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

    def log_error(self, *args):
        # Aborted-connection noise only reaches here as "code 400, message Bad
        # request version" style lines; keep the dev console readable.
        pass


# ---------------------------------------------------------------------------
# Terminal QR code for the LAN URL
#
# So a phone on the same Wi-Fi can join by pointing its camera at the console
# instead of typing the Network URL. A tiny pure-Python QR generator (byte mode,
# error-correction level M, versions 1-10) - no third-party deps, matching the
# rest of this repo. Port of the well-trodden nayuki reference algorithm, trimmed
# to what a short "http://ip:port" URL needs; validated end-to-end against an
# OpenCV decoder across versions 2-10.
# ---------------------------------------------------------------------------

# GF(256) log/antilog tables (primitive polynomial 0x11D).
_QR_EXP = [0] * 256
_QR_LOG = [0] * 256


def _qr_init_gf():
    x = 1
    for i in range(255):
        _QR_EXP[i] = x
        _QR_LOG[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    _QR_EXP[255] = _QR_EXP[0]


_qr_init_gf()


def _qr_gmul(a, b):
    if a == 0 or b == 0:
        return 0
    return _QR_EXP[(_QR_LOG[a] + _QR_LOG[b]) % 255]


def _qr_rs_generator(degree):
    g = [1]
    for i in range(degree):
        ng = [0] * (len(g) + 1)
        for j in range(len(g)):
            ng[j] ^= g[j]                             # x * g  (keeps it monic)
            ng[j + 1] ^= _qr_gmul(g[j], _QR_EXP[i])   # alpha^i * g
        g = ng
    return g


def _qr_rs_ecc(data, degree):
    gen = _qr_rs_generator(degree)
    res = list(data) + [0] * degree
    for i in range(len(data)):
        coef = res[i]
        if coef:
            for j in range(len(gen)):
                res[i + j] ^= _qr_gmul(gen[j], coef)
    return res[len(data):]


# version -> (ecc codewords per block, [(block count, data codewords per block)])
_QR_VER = {
    1: (10, [(1, 16)]), 2: (16, [(1, 28)]), 3: (26, [(1, 44)]),
    4: (18, [(2, 32)]), 5: (24, [(2, 43)]), 6: (16, [(4, 27)]),
    7: (18, [(4, 31)]), 8: (22, [(2, 38), (2, 39)]),
    9: (22, [(3, 36), (2, 37)]), 10: (26, [(4, 43), (1, 44)]),
}
_QR_ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}


def _qr_bit(x, i):
    return (x >> i) & 1


def _qr_pick_version(nbytes):
    for v in range(1, 11):
        total_cw = sum(c * d for c, d in _QR_VER[v][1])
        count_bits = 16 if v >= 10 else 8
        if 4 + count_bits + 8 * nbytes <= total_cw * 8:
            return v
    raise ValueError("URL too long for a version-10 QR (%d bytes)" % nbytes)


def _qr_data_codewords(data, version):
    total_bits = sum(c * d for c, d in _QR_VER[version][1]) * 8
    bits = []

    def put(val, n):
        for i in range(n - 1, -1, -1):
            bits.append((val >> i) & 1)

    put(0b0100, 4)                                  # byte mode
    put(len(data), 16 if version >= 10 else 8)      # character count
    for b in data:
        put(b, 8)
    put(0, min(4, total_bits - len(bits)))          # terminator
    while len(bits) % 8:                             # pad to a byte boundary
        bits.append(0)
    pad, i = (0xEC, 0x11), 0
    while len(bits) < total_bits:                    # pad codewords
        put(pad[i % 2], 8)
        i += 1
    return [int("".join(map(str, bits[i:i + 8])), 2) for i in range(0, total_bits, 8)]


def _qr_interleave(data_cw, version):
    ecc_len, groups = _QR_VER[version]
    blocks, idx = [], 0
    for count, dcw in groups:
        for _ in range(count):
            blocks.append(data_cw[idx:idx + dcw])
            idx += dcw
    ecc_blocks = [_qr_rs_ecc(b, ecc_len) for b in blocks]
    out = []
    for i in range(max(len(b) for b in blocks)):
        for b in blocks:
            if i < len(b):
                out.append(b[i])
    for i in range(ecc_len):
        for eb in ecc_blocks:
            out.append(eb[i])
    return out


def _qr_build(codewords, version):
    size = 17 + 4 * version
    mods = [[0] * size for _ in range(size)]
    fn = [[False] * size for _ in range(size)]

    def setf(col, row, val):
        mods[row][col] = 1 if val else 0
        fn[row][col] = True

    for i in range(size):                            # timing patterns
        setf(6, i, i % 2 == 0)
        setf(i, 6, i % 2 == 0)

    def finder(cx, cy):                              # finder + separator ring
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                x, y = cx + dx, cy + dy
                if 0 <= x < size and 0 <= y < size:
                    setf(x, y, max(abs(dx), abs(dy)) not in (2, 4))

    finder(3, 3)
    finder(size - 4, 3)
    finder(3, size - 4)

    pos = _QR_ALIGN[version]                          # alignment patterns
    last = len(pos) - 1
    skip = {(0, 0), (0, last), (last, 0)}
    for i, ax in enumerate(pos):
        for j, ay in enumerate(pos):
            if (i, j) not in skip:
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        setf(ax + dx, ay + dy, max(abs(dx), abs(dy)) != 1)

    setf(8, size - 8, 1)                             # always-dark module

    for i in range(9):                               # reserve format-info cross
        if i != 6:
            setf(i, 8, 0)
            setf(8, i, 0)
    for i in range(8):
        setf(size - 1 - i, 8, 0)
        setf(8, size - 1 - i, 0)

    if version >= 7:                                 # version-info blocks
        rem = version
        for _ in range(12):
            rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
        vbits = (version << 12) | rem
        for i in range(18):
            bit = _qr_bit(vbits, i)
            a, b = size - 11 + i % 3, i // 3
            setf(b, a, bit)
            setf(a, b, bit)

    bit = 0                                          # data/ecc up-down zigzag
    for right in range(size - 1, 0, -2):
        if right <= 6:
            right -= 1                               # step past timing column
        upward = ((right + 1) & 2) == 0
        for i in range(size):
            row = (size - 1 - i) if upward else i
            for c in (right, right - 1):
                if not fn[row][c]:
                    val = 0
                    if bit < len(codewords) * 8:
                        val = _qr_bit(codewords[bit >> 3], 7 - (bit & 7))
                    mods[row][c] = val
                    bit += 1
    return mods, fn, size


def _qr_mask(m, col, row):
    if m == 0:
        return (row + col) % 2 == 0
    if m == 1:
        return row % 2 == 0
    if m == 2:
        return col % 3 == 0
    if m == 3:
        return (row + col) % 3 == 0
    if m == 4:
        return (row // 2 + col // 3) % 2 == 0
    if m == 5:
        return (row * col) % 2 + (row * col) % 3 == 0
    if m == 6:
        return ((row * col) % 2 + (row * col) % 3) % 2 == 0
    return ((row + col) % 2 + (row * col) % 3) % 2 == 0


def _qr_place_format(mods, size, mask):
    data = mask                                      # EC level M -> 0b00
    rem = data
    for _ in range(10):
        rem = (rem << 1) ^ ((rem >> 9) * 0x537)
    bits = ((data << 10) | rem) ^ 0x5412
    for i in range(6):                               # copy 1
        mods[i][8] = _qr_bit(bits, i)
    mods[7][8] = _qr_bit(bits, 6)
    mods[8][8] = _qr_bit(bits, 7)
    mods[8][7] = _qr_bit(bits, 8)
    for i in range(9, 15):
        mods[8][14 - i] = _qr_bit(bits, i)
    for i in range(8):                               # copy 2
        mods[8][size - 1 - i] = _qr_bit(bits, i)
    for i in range(8, 15):
        mods[size - 15 + i][8] = _qr_bit(bits, i)
    mods[size - 8][8] = 1


def _qr_penalty(mods, size):
    score = 0
    p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
    p2 = list(reversed(p1))
    lines = [row[:] for row in mods] + \
            [[mods[r][c] for r in range(size)] for c in range(size)]
    for line in lines:
        run = 1
        for i in range(1, size):
            if line[i] == line[i - 1]:
                run += 1
                if run == 5:
                    score += 3
                elif run > 5:
                    score += 1
            else:
                run = 1
        for i in range(size - 11):
            seg = line[i:i + 11]
            if seg == p1 or seg == p2:
                score += 40
    for r in range(size - 1):
        for c in range(size - 1):
            v = mods[r][c]
            if v == mods[r][c + 1] == mods[r + 1][c] == mods[r + 1][c + 1]:
                score += 3
    ratio = sum(sum(row) for row in mods) * 100 // (size * size)
    score += (abs(ratio - 50) // 5) * 10
    return score


def qr_matrix(text):
    """QR module grid for text (list of rows of bool, True = dark)."""
    version = _qr_pick_version(len(text.encode("utf-8")))
    codewords = _qr_interleave(_qr_data_codewords(text.encode("utf-8"), version), version)
    base, fn, size = _qr_build(codewords, version)
    best, best_score = None, None
    for m in range(8):
        mods = [row[:] for row in base]
        for r in range(size):
            for c in range(size):
                if not fn[r][c] and _qr_mask(m, c, r):
                    mods[r][c] ^= 1
        _qr_place_format(mods, size, m)
        s = _qr_penalty(mods, size)
        if best_score is None or s < best_score:
            best, best_score = mods, s
    return [[bool(v) for v in row] for row in best]


def qr_terminal(text, quiet=3):
    """Black-on-white block art with a quiet zone, for any ANSI terminal."""
    grid = qr_matrix(text)
    size = len(grid)
    black = "\x1b[40m  \x1b[0m"
    white = "\x1b[107m  \x1b[0m"
    out = [white * (size + 2 * quiet)] * quiet
    for row in grid:
        out.append(white * quiet + "".join(black if v else white for v in row) + white * quiet)
    out += [white * (size + 2 * quiet)] * quiet
    return "\n".join(out)


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
