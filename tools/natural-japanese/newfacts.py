# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "sudachipy>=0.6.8",
#     "sudachidict-core>=20240409",
# ]
# ///
"""newfacts.py — 直した文書にだけあって、元の文書にない数値・固有名詞・英字の語を一覧にする。

既存の文書を直すときに、元にない事実を足していないかを確かめる補助(SKILL.md §6)。
「検出は機械、判断はAI」に従い、一覧に出た語が本当に元にない事実かどうかの判断はしない。

検出できるのは、新しく出てきた数値・固有名詞・英字の語だけである。普通の名詞で足した細部、
確信の度合いの変化(「次回相談」→「合意した」)、発言者の入れ替えは検出できない。
何も出なくても、元にない内容がないとは言い切れない。

測定(2026-10、sonnet の推敲47本と、意味の変化の判定器の結果との比較):
判定器が「元にない事実なし」とした14本では1語も出さず、「あり」とした24本のうち11本で語を出した。

使い方:
    uv run scripts/newfacts.py <元の文書> <直した文書> [--json]
    uv run scripts/newfacts.py --git <直した文書> [--json]   # git の直前のコミットの内容を元の文書として比べる

入力エラーは exit code 1、それ以外は exit code 0(判断は AI に委ねる。ほかの検査と同じ方針)。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

from textcore import get_tokenizer, read_source_file

FENCE = re.compile(r"^(```|~~~).*?^\1", re.M | re.S)
NUM = re.compile(r"\d+(?:[.,]\d+)?\s*(?:%|件|分|時間|日|年|月|倍|人|名|割|円|回|個|本|字|週|営業日|チーム|万|点)?")
ASCII = re.compile(r"[A-Za-z][A-Za-z0-9.+\-_]*[A-Za-z0-9]")


def norm(s: str) -> str:
    """全角と半角、大文字と小文字の違いをそろえる。"""
    return unicodedata.normalize("NFKC", s).lower()


def items(text: str) -> set[str]:
    out = {m.group(0).replace(" ", "") for m in NUM.finditer(text)}
    out |= {m.group(0) for m in ASCII.finditer(text)}
    tok = get_tokenizer()
    for line in text.split("\n"):
        if not line.strip():
            continue
        for m in tok.tokenize(line):
            pos = m.part_of_speech()
            if pos[0] == "名詞" and pos[1] == "固有名詞":
                out.add(m.surface())
    return out


def bare_number(s: str) -> str:
    return re.sub(r"[^\d.]", "", s)


def new_items(original: str, revised: str) -> list[str]:
    orig = norm(original)
    # 元の文書はコードも含めた全文で数え、直した文書はコードブロックを除いて数える
    a = items(orig)
    b = items(norm(FENCE.sub("", revised)))
    # 数字は単位や書き方(「2018/3」と「2018年3月」)が変わるだけのことが多いので、数字そのものが元にあれば除く
    bare = {bare_number(x) for x in a if re.match(r"\d", x)}
    cand = {x for x in b - a if not (re.match(r"\d", x) and bare_number(x) in bare)}
    # 語の切り分け方の違い(「WebGL/WebGPU」、普通名詞と固有名詞の判定の揺れ)で新しく見えるものを除く
    return sorted(x for x in cand if x not in orig)


def locate(revised: str, word: str) -> list[tuple[int, str]]:
    out = []
    for no, line in enumerate(revised.split("\n"), 1):
        if word in norm(line):
            out.append((no, line.strip()))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="直した文書にだけある数値・固有名詞・英字の語を一覧にする")
    ap.add_argument("files", type=Path, nargs="+", help="元の文書と直した文書。--git のときは直した文書だけ")
    ap.add_argument("--git", action="store_true", help="git の直前のコミット(HEAD)の内容を元の文書として比べる")
    ap.add_argument("--json", action="store_true", help="JSON で出力する")
    a = ap.parse_args()
    if a.git:
        if len(a.files) != 1:
            print("エラー: --git のときは、直した文書を1つだけ指定してください", file=sys.stderr)
            return 1
        revised, err = read_source_file(a.files[0])
        if err:
            print(err, file=sys.stderr)
            return 1
        path = a.files[0].resolve()
        r = subprocess.run(["git", "show", f"HEAD:./{path.name}"], cwd=path.parent, capture_output=True, text=True)
        if r.returncode != 0:
            print(f"エラー: git の直前のコミットに {a.files[0]} が見つかりません(git で管理していないか、まだコミットしていない)", file=sys.stderr)
            return 1
        original = r.stdout
    else:
        if len(a.files) != 2:
            print("エラー: 元の文書と直した文書の2つを指定してください(git で管理しているなら --git を使える)", file=sys.stderr)
            return 1
        texts = []
        for p in a.files:
            text, err = read_source_file(p)
            if err:
                print(err, file=sys.stderr)
                return 1
            texts.append(text)
        original, revised = texts
    found = [{"word": w, "lines": [{"line": n, "text": t} for n, t in locate(revised, w)]} for w in new_items(original, revised)]
    if a.json:
        print(json.dumps({"new_items": found}, ensure_ascii=False, indent=2))
        return 0
    print(f"=== 元の文書にない数値・固有名詞・英字の語: {len(found)}件 ===")
    for f in found:
        print(f"- {f['word']}")
        for ln in f["lines"][:3]:
            print(f"    L{ln['line']}: {ln['text'][:100]}")
    print()
    print("※ 検出できるのは新しく出てきた数値・固有名詞・英字の語だけ。普通の名詞で足した細部、確信の度合いの変化、")
    print("   発言者の入れ替えは検出できない。0件でも、元にない内容がないとは限らない。")
    print("※ 一覧に出た語が元にない事実なら、削るか元の内容に戻す。元の文書から直接言える補足(略語の正式名称など)なら残してよい。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
