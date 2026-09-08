"""Score every first-party prose file in the repo against ASD-STE100.

Usage:
    python tools/ste-audit.py              # rank all first-party markdown
    python tools/ste-audit.py --top 15     # show the worst 15 only
    python tools/ste-audit.py --json       # machine-readable

Build output, dependencies, and third-party licence text stay out of the scan.
"""
import argparse
import importlib.util
import json
import os
import sys

LINT_PATH = os.path.expanduser("~/.claude/skills/asd-ste100/scripts/ste-lint.py")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SKIP_DIRS = {"node_modules", ".git", "venv", ".venv", ".next", "out",
             "portable", "dist", "build", "__pycache__", ".claude"}
SKIP_NAMES = {"LICENSE", "LICENSE.md", "THIRD-PARTY.md"}


def load_linter():
    spec = importlib.util.spec_from_file_location("ste_lint", LINT_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def first_party_files():
    for base, dirs, names in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in names:
            if not name.endswith(".md"):
                continue
            if name in SKIP_NAMES or "LICENSE" in name or "-OFL" in name:
                continue
            yield os.path.join(base, name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=0)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--min-words", type=int, default=80)
    args = ap.parse_args()

    ste = load_linter()
    rows = []
    for path in first_party_files():
        with open(path, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        report = ste.lint(text)
        if report["words"] < args.min_words:
            continue
        hits = {k: v for k, v in report["violations"].items() if v}
        rows.append({
            "file": os.path.relpath(path, ROOT).replace("\\", "/"),
            "words": report["words"],
            "score": report["total_per100w"],
            "shape": report["shape_total"],
            "em_dash": report["em_dash(slop-marker)"],
            "top": sorted(hits.items(), key=lambda kv: -kv[1])[:3],
        })

    rows.sort(key=lambda r: -r["score"])
    shown = rows[: args.top] if args.top else rows

    if args.json:
        print(json.dumps(shown, indent=2))
        return 0

    print("%-52s %6s %7s %6s  %s" % ("file", "words", "per100w", "shape", "top categories"))
    print("-" * 118)
    for r in shown:
        top = ", ".join("%s %d" % (k, v) for k, v in r["top"])
        print("%-52s %6d %7.2f %6d  %s" % (r["file"][:52], r["words"], r["score"], r["shape"], top))

    over = [r for r in rows if r["score"] > 2.5]
    total_words = sum(r["words"] for r in rows)
    weighted = sum(r["score"] * r["words"] for r in rows) / (total_words or 1)
    print("-" * 118)
    print("%d files, %d words, weighted mean %.2f per 100w, %d files over the 2.5 target"
          % (len(rows), total_words, weighted, len(over)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
