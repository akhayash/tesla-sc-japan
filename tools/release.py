"""Release notes tooling.

docs/data/releases.json is the single source of truth for versions (newest first).

  python tools/release.py changelog        # regenerate CHANGELOG.md
  python tools/release.py check            # validate releases.json and that CHANGELOG.md is current
  python tools/release.py notes 1.2.0      # print the release notes (Markdown) for one version
  python tools/release.py latest           # print the newest version number
  python tools/release.py backfill         # create missing tags + GitHub releases for past versions (uses git and gh)
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "docs" / "data" / "releases.json"
CHANGELOG = ROOT / "CHANGELOG.md"
REPO_URL = "https://github.com/akhayash/tesla-sc-japan"
SITE_URL = "https://akhayash.github.io/tesla-sc-japan/"
SECTIONS = [("added", "追加"), ("changed", "変更"), ("fixed", "修正"), ("removed", "削除")]
SEMVER = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def load() -> list[dict]:
    return json.loads(SRC.read_text(encoding="utf-8"))["releases"]


def validate(rels: list[dict]) -> list[str]:
    errs, seen, prev = [], set(), None
    for r in rels:
        v = r.get("version", "")
        m = SEMVER.match(v)
        if not m:
            errs.append(f"invalid version: {v!r}")
            continue
        key = tuple(map(int, m.groups()))
        if v in seen:
            errs.append(f"duplicate version: {v}")
        seen.add(v)
        if prev and key >= prev:
            errs.append(f"versions must be newest first: {v}")
        prev = key
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", r.get("date", "")):
            errs.append(f"{v}: date must be YYYY-MM-DD")
        if not r.get("title"):
            errs.append(f"{v}: title is required")
        if not any(r.get(k) for k, _ in SECTIONS):
            errs.append(f"{v}: at least one of {[k for k, _ in SECTIONS]} is required")
    return errs


def body(r: dict) -> str:
    out = []
    for key, label in SECTIONS:
        items = r.get(key) or []
        if items:
            out.append(f"### {label}")
            out += [f"- {i}" for i in items]
            out.append("")
    return "\n".join(out).rstrip() + "\n"


def changelog(rels: list[dict]) -> str:
    lines = [
        "# 変更履歴",
        "",
        f"このファイルは `docs/data/releases.json` から `python tools/release.py changelog` で生成しています（直接編集しないでください）。",
        f"サイト上の表示：[リリースノート]({SITE_URL}releases.html)。バージョンは [Semantic Versioning](https://semver.org/lang/ja/) に従います。",
        "充電器データの週次自動更新はバージョンに含めません。",
        "",
    ]
    for i, r in enumerate(rels):
        v = r["version"]
        prev = rels[i + 1]["version"] if i + 1 < len(rels) else None
        compare = f"{REPO_URL}/compare/v{prev}...v{v}" if prev else f"{REPO_URL}/releases/tag/v{v}"
        lines += [f"## [{v}]({compare}) - {r['date']}", "", f"**{r['title']}**", "", body(r)]
    return "\n".join(lines).rstrip() + "\n"


def run(*args: str, env: dict | None = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(args, cwd=ROOT, text=True, capture_output=True, check=check, env=env, encoding="utf-8")


def backfill(rels: list[dict]) -> None:
    existing = set(run("git", "tag", "--list", "v*").stdout.split())
    for r in reversed(rels):
        tag = f"v{r['version']}"
        commit = r.get("commit")
        if tag in existing:
            print(f"{tag}: tag exists")
        elif not commit:
            print(f"{tag}: no commit recorded; skipped")
            continue
        else:
            date = run("git", "log", "-1", "--format=%cI", commit).stdout.strip()
            env = {**os.environ, "GIT_COMMITTER_DATE": date}
            run("git", "tag", "-a", tag, commit, "-m", f"{tag} {r['title']}", env=env)
            print(f"{tag}: tagged {commit} ({date})")
        run("git", "push", "origin", tag)
        if run("gh", "release", "view", tag, check=False).returncode == 0:
            print(f"{tag}: release exists")
            continue
        notes = f"{r['date']} リリース\n\n{body(r)}"
        args = ["gh", "release", "create", tag, "--title", f"{tag} {r['title']}", "--notes", notes, "--verify-tag"]
        if r is not rels[0]:
            args.append("--latest=false")
        run(*args)
        print(f"{tag}: release created")


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    rels = load()
    errs = validate(rels)
    if errs:
        print("\n".join(errs), file=sys.stderr)
        return 1
    if cmd == "changelog":
        CHANGELOG.write_text(changelog(rels), encoding="utf-8", newline="\n")
        print(f"wrote {CHANGELOG.relative_to(ROOT)}")
    elif cmd == "check":
        current = CHANGELOG.read_text(encoding="utf-8") if CHANGELOG.exists() else ""
        if current.replace("\r\n", "\n") != changelog(rels):
            print("CHANGELOG.md is out of date; run: python tools/release.py changelog", file=sys.stderr)
            return 1
        print(f"ok: {len(rels)} releases, latest {rels[0]['version']}")
    elif cmd == "notes":
        v = sys.argv[2].removeprefix("v")
        r = next((r for r in rels if r["version"] == v), None)
        if not r:
            print(f"unknown version {v}", file=sys.stderr)
            return 1
        sys.stdout.reconfigure(encoding="utf-8")
        print(f"{r['date']} リリース\n\n{body(r)}", end="")
    elif cmd == "latest":
        print(rels[0]["version"])
    elif cmd == "title":
        v = sys.argv[2].removeprefix("v")
        sys.stdout.reconfigure(encoding="utf-8")
        print(next(r["title"] for r in rels if r["version"] == v))
    elif cmd == "backfill":
        backfill(rels)
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
