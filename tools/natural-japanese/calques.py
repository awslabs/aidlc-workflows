# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "sudachipy>=0.6.8",
#     "sudachidict-core>=20240409",
# ]
# ///
"""calques.py — 仕組みを場所にたとえた名詞と、機械の処理に当てた動詞の候補を並べる(EXPERIMENTAL)。

書いたモデルは自分の意図で読み返すので、「入口」「効く」のような言葉に自分では気づけない。
指摘されれば直せるので、このスクリプトは気づく段階だけを受け持つ。判断はしない。
誤検出は多めに出る前提で、直すかどうかはエージェントが次の2つの問いで決める。
    - この語は、読み手の分野で決まった呼び名か(別の決まった呼び名があるなら直す)
    - この動詞だけで、何が起きるかが分かるか(分からないなら、起きることを書く)

候補にする型は2つ。
    verb   人や物の動きを、機械の処理に当てはめた動詞(拾う・引く・通る・効く・響く・足す など)。
           直前が助詞「が・を・に・も・は」のものだけ
    place  仕組みを場所にたとえて指した名詞(入口・受け口・口・依存先 など)。「口」「先」で終わる名詞
分野の決まった呼び名からずれた漢語(事実・要求・承認 など)は、語の形では見分けられないので対象外。

見出し・箇条書き・表・図(mermaid)の文字も対象にする(短く書く場所ほど言葉がずれやすいため)。
それ以外のコードブロックとインラインコードは対象にしない。

使い方:
    uv run scripts/calques.py <file.md> [--json]

入力エラーは exit code 1、それ以外は 0。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from textcore import get_tokenizer, read_source_file

# 人や物の動きを表す和語の動詞(原形)。文書から逆算した除外リストではなく、型の定義から挙げる。
MOTION_VERBS = {
    "拾う", "引く", "通る", "通す", "効く", "利く", "響く", "足す", "抜ける", "抜く", "落ちる", "落とす",
    "走る", "走らせる", "乗る", "乗せる", "回す", "回る", "投げる", "吐く", "叩く", "刺さる", "刺す",
    "生える", "流れる", "流す", "握る", "噛む", "食う", "食べる", "飛ぶ", "飛ばす", "弾く", "掴む",
    "潰す", "潰れる", "殺す", "死ぬ", "生きる", "育つ", "眠る", "溜まる", "溜める", "詰まる", "絡む",
    "漏れる", "溢れる", "折れる", "割れる", "崩れる", "背負う", "抱える", "担ぐ", "跨ぐ", "踏む",
    "触る", "当たる", "当てる", "被る", "かぶる", "寄せる", "寄る", "逃がす", "逃げる", "剥がす",
    "捌く", "さばく", "裁く", "捕まえる", "掬う", "すくう", "汲む", "撫でる", "揉む", "絞る", "締める",
}
_PARTICLES = {"が", "を", "に", "も", "は"}
# 「先」は単独の形態素(依存|先、つないでいる|先)だけ。「優先」「宛先」のような1語は候補にしない
_PLACE_RE = re.compile(r"先|[一-鿿々ぁ-ん]*口")
_FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
_INLINE_CODE_RE = re.compile(r"`[^`]*`")
_JA_RE = re.compile(r"[぀-ヿ一-鿿]")


def iter_text_lines(text: str):
    fence = None
    diagram = False
    for no, line in enumerate(text.split("\n"), start=1):
        m = _FENCE_RE.match(line)
        if m:
            mark = m.group(1)[0]
            if fence is None:
                fence = mark
                diagram = line.strip().lstrip("`~").strip().lower() == "mermaid"
            elif fence == mark:
                fence = None
            continue
        # 図(mermaid)の箱や矢印の文字は、短く書くので言葉がずれやすい。読む対象に入れる
        if (fence is None or diagram) and _JA_RE.search(line):
            yield no, _INLINE_CODE_RE.sub(" ", line)


def find_candidates(text: str) -> list[dict]:
    tok = get_tokenizer()
    out = []
    for no, line in iter_text_lines(text):
        ms = list(tok.tokenize(line))
        for i, m in enumerate(ms):
            pos = m.part_of_speech()
            base = m.dictionary_form()
            if pos[0] == "動詞" and base in MOTION_VERBS and i and ms[i - 1].surface() in _PARTICLES:
                out.append({"line": no, "kind": "verb", "word": base, "text": line.strip()})
            elif pos[0] == "名詞" and _PLACE_RE.fullmatch(m.surface()):
                out.append({"line": no, "kind": "place", "word": m.surface(), "text": line.strip()})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("file")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    text, err = read_source_file(Path(args.file))
    if err:
        print(err, file=sys.stderr)
        return 1
    cands = find_candidates(text)
    if args.json:
        print(json.dumps(cands, ensure_ascii=False, indent=2))
        return 0
    if not cands:
        print("候補なし")
        return 0
    print("| 行 | 型 | 語 | 文 | 読み手の分野の呼び名か / 何が起きるか分かるか | 直す・残す |")
    print("|---|---|---|---|---|---|")
    for c in cands:
        print(f"| {c['line']} | {c['kind']} | {c['word']} | {c['text'][:60]} |  |  |")
    return 0


if __name__ == "__main__":
    sys.exit(main())
