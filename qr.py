#!/usr/bin/env python3
"""Terminal QR code, in pure Python.

Lifted out of serve.py, where it was 60% of the file: a dev server whose job is
three routes and a MIME table had a Reed-Solomon encoder sitting in the middle
of it. Nothing about it changed in the move.

So a phone on the same Wi-Fi can join by pointing its camera at the console
instead of typing the Network URL. Byte mode, error-correction level M,
versions 1-10 - no third-party deps, matching the rest of this repo. Port of
the well-trodden nayuki reference algorithm, trimmed to what a short
"http://ip:port" URL needs; validated end-to-end against an OpenCV decoder
across versions 2-10.

Public surface is qr_matrix(text) and qr_terminal(text, quiet=3); everything
prefixed with _qr_ is working machinery.
"""

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
