# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "sudachipy>=0.6.8",
#     "sudachidict-core>=20240409",
# ]
# ///
"""outline.py — 文書のスケルトン（見出し・各段落の先頭文・箇条書き）を抽出する。

設計原則「検出は機械、判断はAI」に基づき、良し悪しの判断はせず、決定的な抽出のみを
行う。SKILL.md §4 の構造レビュー（スケルトン通読）への入力として使う。

スケルトンに加えて「見出し統計」も出力する（本数・レベル分布、見出し長の平均・
変動係数、体言止め率、見出し間のPOSパターン一致率、テンプレ見出し語彙ヒット、
連番/記号などの構造パターン率）。これらは severity 付きの検出結果（Finding）
ではなく、AI臭いかどうかを読む側のAIが判断するための材料の提示に留める
——見出し統計そのものが「AI臭い/自然」を断定することはしない。

使い方:
    uv run scripts/outline.py <file.md> [--json]

入力エラー（ファイル不在・ディレクトリ指定・読み取り不可等）は exit code 1、
それ以外は exit code 0（判断は人間/AIに委ねる。ほかの検査スクリプトと同じ方針）。

見出し統計の体言止め判定・POSシグネチャ化には sudachipy を使うため、
textcore.py と同じ PEP 723 メタデータを宣言しておく。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from textcore import (
    NOUN_ENDING_POS,
    TEMPLATE_HEADING_WORDS,
    _BLOCKQUOTE_RE,
    _CODE_FENCE_RE,
    _FRONT_MATTER_DELIM_RE,
    _HEADING_RE,
    _LIST_ITEM_RE,
    _TABLE_DELIMITER_RE,
    _TABLE_ROW_RE,
    _heading_level_and_text,
    get_tokenizer,
    mask_html_comments,
    read_source_file,
    strip_trailing_symbols,
)

# ---------------------------------------------------------------------------
# --outline（スケルトン抽出）
#
# 設計原則「検出は機械、判断はAI」に基づき、文書の構造（見出し・各段落の先頭文・
# 箇条書きブロック）を決定的に抽出するだけで、良し悪しの判断はしない。
# SKILL.md §4 の構造レビュー（スケルトン通読）への入力として使う。
#
# 見出し・コードブロック・引用・表のマスクには mask_markdown_structure() は使わない
# （見出し行そのものが空文字になってしまい、スケルトンの主役である見出しテキストが
# 消えてしまうため）。かわりに、見出し検出は生テキストに対して直接行い、
# 段落は「空行区切りの行グループ」として独自に走査する。HTMLコメントのみ
# mask_html_comments() で先に空白化し、コメント内の見出し風・箇条書き風の行を
# 誤ってスケルトンに含めないようにする。
# ---------------------------------------------------------------------------


def build_outline(raw_text: str) -> list[dict]:
    """文書のスケルトン（見出し・各段落の先頭文・箇条書きプレースホルダ）を
    行番号付きで抽出する。判断はせず、決定的な抽出のみを行う。

    - 見出し行（#〜######）: kind="heading", level=1-6
    - 空行区切りの段落のうち、箇条書き・コードブロック・引用・表以外: kind="lead"
      （段落先頭行の最初の文、句点等が無ければ先頭行全体）
    - 箇条書きだけの段落: kind="bullets"（「(箇条書き N 項目)」プレースホルダ）
    - コードブロック・引用・表の段落は出力しない（スキップ）

    ブロックの区切りは空行だけではない。箇条書き行の直後に空行なしで通常段落行が
    続く（またはその逆順の）場合も、そこでブロック種別が切り替わるため flush する
    （空行がないからといって同じブロックにまとめてしまうと、後続ブロックの内容が
    丸ごと出力から消えてしまう）。
    """
    text = mask_html_comments(raw_text)
    lines = text.split("\n")

    outline: list[dict] = []
    buffer: list[tuple[int, str]] = []
    in_fence = False
    fence_char = ""
    fence_len = 0
    in_front_matter = False

    def line_kind(line_text: str) -> str:
        """flush_buffer() のブロック種別判定（buffer[0] 基準）と対応する、
        単一行の分類。ブロック種別が切り替わったかどうかの判定に使う。"""
        if _LIST_ITEM_RE.match(line_text):
            return "bullets"
        if _BLOCKQUOTE_RE.match(line_text):
            return "blockquote"
        if (_TABLE_ROW_RE.match(line_text) and line_text.count("|") >= 2) or _TABLE_DELIMITER_RE.match(
            line_text
        ):
            return "table"
        return "lead"

    def flush_buffer() -> None:
        if not buffer:
            return
        first_no, first_line = buffer[0]
        if _LIST_ITEM_RE.match(first_line):
            count = sum(1 for _, line_text in buffer if _LIST_ITEM_RE.match(line_text))
            outline.append(
                {"line": first_no, "kind": "bullets", "level": None, "text": f"(箇条書き {count} 項目)"}
            )
        elif _BLOCKQUOTE_RE.match(first_line):
            pass  # 引用ブロックは段落として扱わずスキップ
        elif (_TABLE_ROW_RE.match(first_line) and first_line.count("|") >= 2) or _TABLE_DELIMITER_RE.match(
            first_line
        ):
            pass  # 表はスキップ
        else:
            m = re.search(r"[。！？]", first_line)
            lead = first_line[: m.end()] if m else first_line
            lead = lead.strip()
            if lead:
                outline.append({"line": first_no, "kind": "lead", "level": None, "text": lead})
        buffer.clear()

    for i, line in enumerate(lines, start=1):
        if i == 1 and _FRONT_MATTER_DELIM_RE.match(line):
            in_front_matter = True
            continue
        if in_front_matter:
            if _FRONT_MATTER_DELIM_RE.match(line):
                in_front_matter = False
            continue

        fence_match = _CODE_FENCE_RE.match(line)
        if fence_match:
            flush_buffer()
            fence_run = fence_match.group(1)
            fc, fl = fence_run[0], len(fence_run)
            is_close_eligible = line[fence_match.end() :].strip() == ""
            if not in_fence:
                in_fence = True
                fence_char, fence_len = fc, fl
            elif fc == fence_char and fl >= fence_len and is_close_eligible:
                in_fence = False
            continue
        if in_fence:
            continue

        if not line.strip():
            flush_buffer()
            continue

        if _HEADING_RE.match(line):
            flush_buffer()
            level, heading_text = _heading_level_and_text(line)
            outline.append({"line": i, "kind": "heading", "level": level, "text": heading_text})
            continue

        # 空行を挟まずにブロック種別（箇条書き/引用/表/通常段落）が切り替わった
        # 場合も、そこで現在のバッファを確定させてから新しいブロックを始める。
        # ただし箇条書きブロックの途中に現れるインデントされた継続行（折り返された
        # 項目の2行目以降。行頭に空白がありマーカーを持たない）は、種別変化とみなさず
        # 同じ箇条書きブロックに含める（マーカー行だけを項目数として数えるので、
        # 継続行が項目数を水増しすることはない）。
        if buffer:
            cur_kind = line_kind(buffer[0][1])
            is_indented_continuation = (
                cur_kind == "bullets"
                and line_kind(line) == "lead"
                and re.match(r"^\s+\S", line) is not None
            )
            if cur_kind != line_kind(line) and not is_indented_continuation:
                flush_buffer()

        buffer.append((i, line))

    flush_buffer()
    return outline


# ---------------------------------------------------------------------------
# 見出し統計（--outline に付随する判断材料の提示）
#
# ここより下は「検出は機械、判断はAI」の"機械"側の追加ブロックである。ただし
# lint.py の検出器群とは性質が異なり、severity 付きの Finding は一切生成しない。
# 見出しの本数・長さ・構造パターンを集計するだけで、「これはAI臭い」という
# 判定はしない（例えば体言止め率が高い見出しでも、技術文書では自然に高くなり
# うる。閾値判断・良し悪しの判断は読む側のAIに委ねる）。
#
# 対象は build_outline() が抽出した kind="heading" のエントリのみ。h1（文書
# タイトル）を含めるかどうかは呼び出し側次第だが、本文の構成パターンを見たい
# という目的上、レベル別統計は「レベルごとの兄弟見出し群」を単位に集計する。
# ---------------------------------------------------------------------------

# POS シグネチャ化で使う粗い品詞カテゴリ。sudachipy の part_of_speech()[0] は
# 「名詞」「動詞」「助詞」等の詳細分類だが、見出し全体の構造パターン（対称性）を
# 見たいだけなので、意味のある大分類のみ抽出し、それ以外（助詞・助動詞・記号・
# 空白等の機能語/記号）はシグネチャから除外する。除外しないと「◯◯の設計」
# 「◯◯の実装」のような対称見出しでも助詞「の」の有無等で微妙にシグネチャが
# ずれ、パターン一致率が実態より低く出てしまう。
_SIGNATURE_POS = {"名詞", "動詞", "形容詞", "副詞", "接頭辞"}

# テンプレ見出し語彙のマッチングは、単純な前方一致だと見出し先頭の記号・番号
# （例:「1. はじめに」「## はじめに」）に引きずられて不一致になる。見出しテキスト
# 側の先頭にある番号・記号を軽く剥がしてから判定する。
_LEADING_NUMBERING_RE = re.compile(r"^[\s0-9０-９.．、,()（）【】\[\]#・-]+")

# 構造的パターン検出用の正規表現。
# 1) 連番: 「1. ◯◯」「1) ◯◯」「①◯◯」など見出しテキスト先頭の番号
_NUMBERED_HEADING_RE = re.compile(r"^\s*([0-9０-９]+[.).、]|[①-⑳])\s*\S")
# 2) 括弧見出し: 「【◯◯】」「［◯◯］」など全体または先頭を囲む記号
_BRACKETED_HEADING_RE = re.compile(r"^\s*[【\[［(（].+[】\]］)）]\s*$")
# 3) 「◯◯とは」型: 定義提示の定型
_TOWA_HEADING_RE = re.compile(r".+とは[?？]?\s*$")


def _heading_pos_signature(text: str) -> tuple[str, ...]:
    """見出しテキストの粗い品詞列（機能語・記号を除く）をタプル化したもの。
    同一シグネチャの兄弟見出しが多いほど、構造的に対称な（＝AIが書きがちな
    テンプレ的な）見出し群である可能性が高い、という判断材料になる。
    """
    tokenizer = get_tokenizer()
    sig = []
    for m in tokenizer.tokenize(text):
        pos = m.part_of_speech()[0]
        if pos in _SIGNATURE_POS:
            sig.append(pos)
    return tuple(sig)


def _is_nominal_ending(text: str) -> bool:
    """見出し末尾の実質的な最終形態素が名詞かどうか（体言止め判定）。
    lint.py の文末体言止め判定（detect_nominal_ending_and_paragraph_conjunctions）
    と同じロジックを見出しテキストに適用する。空見出しは False 扱い。
    """
    tokenizer = get_tokenizer()
    morphemes = list(tokenizer.tokenize(text))
    effective = strip_trailing_symbols(morphemes)
    if not effective:
        return False
    return effective[-1].part_of_speech()[0] in NOUN_ENDING_POS


def _match_template_word(text: str) -> str | None:
    """見出し先頭の番号・記号を除いたうえで、テンプレ見出し語彙カタログ
    （TEMPLATE_HEADING_WORDS）の前方一致を判定する。ヒットした最初の語を返す。
    """
    stripped = _LEADING_NUMBERING_RE.sub("", text).strip().lower()
    for word in TEMPLATE_HEADING_WORDS:
        if stripped.startswith(word.lower()):
            return word
    return None


def _match_structural_pattern(text: str) -> str | None:
    """連番・括弧・「◯◯とは」型など、構造的な定型パターンに一致するか判定する。
    複数該当しうるが、提示上は最初に一致したもの1つを採用する。
    """
    if _NUMBERED_HEADING_RE.match(text):
        return "numbered"
    if _BRACKETED_HEADING_RE.match(text):
        return "bracketed"
    if _TOWA_HEADING_RE.match(text):
        return "towa"
    return None


def _summarize_heading_group(headings: list[dict]) -> dict:
    """見出し群（同一レベルの兄弟、または文書全体）1つ分の統計をまとめる。
    headings は build_outline() の kind="heading" エントリのリスト。
    """
    count = len(headings)
    if count == 0:
        return {
            "count": 0,
            "length_mean": 0.0,
            "length_cv": 0.0,
            "nominal_ending_ratio": 0.0,
            "dominant_pos_signature_ratio": 0.0,
            "template_hits": [],
            "structural_pattern_ratio": 0.0,
        }

    lengths = [len(h["text"]) for h in headings]
    mean_len = sum(lengths) / count
    if mean_len > 0 and count > 1:
        variance = sum((length - mean_len) ** 2 for length in lengths) / count
        stdev = variance**0.5
        cv = stdev / mean_len
    else:
        cv = 0.0

    nominal_count = sum(1 for h in headings if _is_nominal_ending(h["text"]))

    signatures = [_heading_pos_signature(h["text"]) for h in headings]
    non_empty_signatures = [s for s in signatures if s]
    if non_empty_signatures:
        most_common = max(set(non_empty_signatures), key=non_empty_signatures.count)
        dominant_ratio = non_empty_signatures.count(most_common) / count
    else:
        dominant_ratio = 0.0

    template_hits = []
    for h in headings:
        word = _match_template_word(h["text"])
        if word is not None:
            template_hits.append({"line": h["line"], "text": h["text"], "matched": word})

    structural_count = sum(1 for h in headings if _match_structural_pattern(h["text"]) is not None)

    return {
        "count": count,
        "length_mean": round(mean_len, 2),
        "length_cv": round(cv, 3),
        "nominal_ending_ratio": round(nominal_count / count, 3),
        "dominant_pos_signature_ratio": round(dominant_ratio, 3),
        "template_hits": template_hits,
        "structural_pattern_ratio": round(structural_count / count, 3),
    }


def build_heading_stats(outline: list[dict]) -> dict:
    """スケルトンから見出しだけを取り出し、レベル別（h1〜h6）＋文書全体の
    統計をまとめる。severity や良し悪しの判断は含めない（判断材料の提示のみ）。
    """
    headings = [e for e in outline if e["kind"] == "heading"]
    by_level: dict[int, list[dict]] = {}
    for h in headings:
        by_level.setdefault(h["level"], []).append(h)

    level_distribution = {str(level): len(hs) for level, hs in sorted(by_level.items())}

    return {
        "total_headings": len(headings),
        "level_distribution": level_distribution,
        "by_level": {
            str(level): _summarize_heading_group(hs) for level, hs in sorted(by_level.items())
        },
        "overall": _summarize_heading_group(headings),
    }


def print_heading_stats_human(stats: dict) -> None:
    print()
    print("=== 見出し統計（判断材料。判定はAIが行う） ===")
    print()
    print(f"見出し総数: {stats['total_headings']}")
    if stats["level_distribution"]:
        dist = ", ".join(f"h{level}={n}" for level, n in stats["level_distribution"].items())
        print(f"レベル分布: {dist}")

    def print_group(label: str, g: dict) -> None:
        if g["count"] == 0:
            return
        print(f"[{label}] 本数={g['count']}  平均長={g['length_mean']}字  "
              f"長さの変動係数={g['length_cv']}  体言止め率={g['nominal_ending_ratio']:.0%}  "
              f"品詞パターン一致率={g['dominant_pos_signature_ratio']:.0%}  "
              f"構造パターン率={g['structural_pattern_ratio']:.0%}")
        if g["template_hits"]:
            hits = ", ".join(f"L{h['line']}:{h['text']}（{h['matched']}）" for h in g["template_hits"])
            print(f"  テンプレ見出しヒット: {hits}")

    for level, g in stats["by_level"].items():
        print_group(f"h{level}", g)
    print_group("全体", stats["overall"])


def print_outline_human(path: Path, outline: list[dict]) -> None:
    print(f"=== outline: {path} ===")
    print()
    if not outline:
        print("(スケルトンなし)")
        return
    for entry in outline:
        line_tag = f"L{entry['line']}"
        if entry["kind"] == "heading":
            indent = "  " * max(0, entry["level"] - 1)
            prefix = "#" * entry["level"]
            print(f"{line_tag:>6}  {indent}{prefix} {entry['text']}")
        else:
            print(f"{line_tag:>6}    {entry['text']}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="文書のスケルトン（見出し・各段落の先頭文・箇条書き）を抽出する（CI ゲートではない）。"
    )
    parser.add_argument("file", type=Path, help="対象の Markdown/テキストファイル")
    parser.add_argument("--json", action="store_true", help="機械可読な JSON で出力する")
    args = parser.parse_args()

    # 「文章の中身に関する判断」と「そもそも実行できない入力エラー」は区別する。
    # 前者（抽出結果）は exit 0、後者（ファイル不在/ディレクトリ指定/読み取り不可等）は exit 1。
    text, err = read_source_file(args.file)
    if err is not None:
        print(err, file=sys.stderr)
        return 1

    outline = build_outline(text)
    heading_stats = build_heading_stats(outline)
    if args.json:
        print(json.dumps({"outline": outline, "heading_stats": heading_stats}, ensure_ascii=False, indent=2))
    else:
        print_outline_human(args.file, outline)
        print_heading_stats_human(heading_stats)
    return 0


if __name__ == "__main__":
    sys.exit(main())

