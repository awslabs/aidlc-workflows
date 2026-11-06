# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""paragraphs.py — 文書を段落に分け、番号と行番号を付けた確認用の表を出す。

SKILL.md §3「読み手が何のことか分からない言い回しは、ふだんの言葉に戻す」の手順で使う。
文書全体を通して読むだけだと、モデルは「もう読みやすい」と判断して確認を飛ばす。
段落ごとに表を埋めさせることで、すべての段落を一度ずつ見たことを残す。

判断はしない。分けて並べるだけ。段落の単位は次のとおり。
    - 見出しの行
    - 箇条書きの1項目(続きの行を含む)
    - 表の1行(区切り行は除く)
    - 空行で区切られた地の文
コードブロック、YAML フロントマター、HTML コメントの中は対象にしない。

使い方:
    uv run scripts/paragraphs.py <file.md> > phrases.md
    uv run scripts/paragraphs.py <file.md> --json

入力エラー(ファイル不在など)は exit code 1、それ以外は 0。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

_FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s")
_LIST_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
_TABLE_RE = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_DELIM_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_JA_RE = re.compile(r"[぀-ヿ一-鿿]")


def split_units(text: str) -> list[dict]:
    lines = text.split("\n")
    units: list[dict] = []
    cur: dict | None = None
    fence: str | None = None
    in_front = False
    in_comment = False

    def flush():
        nonlocal cur
        if cur and _JA_RE.search(" ".join(cur["lines"])):
            units.append({"line": cur["line"], "kind": cur["kind"], "text": "\n".join(cur["lines"]).strip()})
        cur = None

    for no, line in enumerate(lines, start=1):
        if no == 1 and line.strip() == "---":
            in_front = True
            continue
        if in_front:
            if line.strip() == "---":
                in_front = False
            continue
        m = _FENCE_RE.match(line)
        if m:
            flush()
            mark = m.group(1)[0]
            if fence is None:
                fence = mark
            elif fence == mark and line.strip().strip(mark) == "":
                fence = None
            continue
        if fence is not None:
            continue
        if in_comment:
            if "-->" in line:
                in_comment = False
            continue
        if line.strip().startswith("<!--"):
            flush()
            in_comment = "-->" not in line
            continue
        if not line.strip():
            flush()
            continue
        if _HEADING_RE.match(line):
            flush()
            cur = {"line": no, "kind": "見出し", "lines": [line]}
            flush()
            continue
        if _TABLE_DELIM_RE.match(line):
            continue
        if _TABLE_RE.match(line):
            flush()
            cur = {"line": no, "kind": "表", "lines": [line]}
            flush()
            continue
        if _LIST_RE.match(line):
            flush()
            cur = {"line": no, "kind": "箇条書き", "lines": [line]}
            continue
        if cur is None:
            cur = {"line": no, "kind": "段落", "lines": [line]}
        else:
            cur["lines"].append(line)
    flush()
    for i, u in enumerate(units, start=1):
        u["no"] = i
    return units


def render(units: list[dict], name: str) -> str:
    out = [
        f"# {name} の段落ごとの確認",
        "",
        "各段落の動詞と名詞をすべて見て、SKILL.md §3「読み手が何のことか分からない言い回し」の型に当たるものを表に書く。"
        "指しているものは、元の文書やコードにある事実・名前で書く。当たるものがない段落は、表の代わりに「なし」と書く。",
        "",
    ]
    for u in units:
        out += [
            f"## {u['no']}({u['line']}行目、{u['kind']})",
            "",
            u["text"],
            "",
            "| 言い回し | 型 | 指しているもの | 直す/残す |",
            "|---|---|---|---|",
            "",
        ]
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("file")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    p = Path(a.file)
    if not p.is_file():
        print(f"ファイルが見つからない: {p}", file=sys.stderr)
        return 1
    try:
        text = p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as e:
        print(f"読み取れない: {p}: {e}", file=sys.stderr)
        return 1
    units = split_units(text)
    if a.json:
        print(json.dumps(units, ensure_ascii=False, indent=1))
    else:
        print(render(units, p.name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
