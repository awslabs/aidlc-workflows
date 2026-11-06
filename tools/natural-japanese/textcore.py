"""textcore.py — 検査スクリプト3本（lint.py / outline.py / terms.py）の共有基盤。

エントリポイントではない（単体実行を想定しない）ため PEP 723 インラインメタデータは
持たない。依存（sudachipy / sudachidict-core）は各エントリスクリプト側で宣言する。
`uv run scripts/lint.py` 等の実行時は sys.path[0] が scripts/ ディレクトリになるため、
同ディレクトリの `import textcore` がそのまま解決できる。

提供するもの:
    - sudachipy Tokenizer の遅延初期化（get_tokenizer）
    - 文分割（split_sentences_with_lines 等）
    - Markdown構造のマスク処理（mask_markdown_structure / mask_html_comments）
    - 行番号付き反復・段落分割ユーティリティ
    - 入力ファイルの読み込みと入力エラー処理（read_source_file）
    - 共有データ構造（Finding）
"""

from __future__ import annotations

import dataclasses
import re
from pathlib import Path

# ---------------------------------------------------------------------------
# 共有データ構造
# ---------------------------------------------------------------------------

@dataclasses.dataclass
class Finding:
    line: int
    category: str
    excerpt: str
    severity: str  # "info" | "warn" | "critical"
    detail: str = ""
    # 文書全体集計型の検出器（antithesis_repetition, repeated_sentence_lead,
    # repeated_syntax_template, paragraph_lead_conjunction, nominal_ending 等）で、
    # 同じ集計に基づく他の該当行番号を列挙するための任意フィールド。
    # 単発検出（forbidden_phrase 等）では None のまま。
    related_lines: list[int] | None = None
    # --baseline 比較を行ったときだけ "new" | "persisting" にセットされる
    # （比較しない通常実行では None のまま。to_dict() で省く）。
    status: str | None = None
    # どう直すかの短い手引き。lint.py がカテゴリごとに付ける（SKILL.md §4 が参照する）。
    hint: str = ""

    def __post_init__(self) -> None:
        # JSON 出力でも detail 表記と同じく重複除去・昇順に正規化する
        if self.related_lines is not None:
            self.related_lines = sorted(set(self.related_lines))

    def to_dict(self) -> dict:
        d = dataclasses.asdict(self)
        # --baseline を使わない通常実行では status は常に None なので、
        # JSON 出力のフィールド構成を従来どおりに保つためキー自体を省く
        # （--baseline なしの挙動は完全に不変、という要件のため）。
        if d.get("status") is None:
            d.pop("status", None)
        if not d.get("hint"):
            d.pop("hint", None)
        return d


# ---------------------------------------------------------------------------
# sudachipy Tokenizer は生成コスト（辞書ロード）が高いので遅延・使い回し。
# ---------------------------------------------------------------------------
_tokenizer_obj = None


def get_tokenizer():
    global _tokenizer_obj
    if _tokenizer_obj is None:
        from sudachipy import Dictionary

        _tokenizer_obj = Dictionary().create()
    return _tokenizer_obj


# ---------------------------------------------------------------------------
# 体言止め判定（lint.py の nominal_ending 検出器と outline.py の見出し統計で共用）。
#
# TRAILING_SYMBOL_POS / NOUN_ENDING_POS / strip_trailing_symbols() は元々
# lint.py 側だけに定義されていたが、outline.py の見出し統計（体言止め率）でも
# 同じ判定ロジックが必要になったため、共有基盤である textcore.py に移設した。
# lint.py は本モジュールから import して使う（値は移設前と完全に同一）。
# ---------------------------------------------------------------------------
NOUN_ENDING_POS = {"名詞"}
TRAILING_SYMBOL_POS = {"補助記号", "空白"}


def strip_trailing_symbols(morphemes: list) -> list:
    """文末（または見出し末尾）の記号（」など）を除いた実質的な最終形態素列を返す。"""
    i = len(morphemes)
    while i > 0 and morphemes[i - 1].part_of_speech()[0] in TRAILING_SYMBOL_POS:
        i -= 1
    return morphemes[:i]


# ---------------------------------------------------------------------------
# テンプレ見出し語彙カタログ（outline.py の見出し統計「テンプレ見出し検出」で使用）。
#
# lint.py の BOILERPLATE_HEADING_WORDS（「まとめ」「おわりに」等、締めの定型句のみ）
# より対象を広げ、書き出し側の定型（「はじめに」「背景」）も含む。outline.py は
# severity 付きの検出器ではなく統計提示なので、ここでのヒットは「AI臭い」の
# 断定ではなく判断材料の一つに過ぎない。拡張前提のカタログとして、見出しの
# 前方一致で判定する（例:「まとめと今後の課題」は「まとめ」にも「今後」にも
# 一部一致しうるが、判定は startswith のみで十分。カタログはリスト順に評価し、
# 最初に一致した語を採用する）。
# ---------------------------------------------------------------------------
TEMPLATE_HEADING_WORDS: list[str] = [
    "はじめに",
    "背景",
    "概要",
    "本記事について",
    "この記事について",
    "まとめと今後",
    "今後の展望",
    "今後の課題",
    "今後について",
    "まとめ",
    "おわりに",
    "終わりに",
    "さいごに",
    "最後に",
    "結論",
    "総括",
    "conclusion",
    "introduction",
    "summary",
]


# ---------------------------------------------------------------------------
# Markdown構造行のマスク処理
# 見出し・リスト項目・コードブロック内・引用ブロックは「文章」ではないため、
# 体言止め判定や翻訳調検出などの対象から外す。行を削除すると後続行の行番号が
# ズレてレポートの L<n> が狂うので、該当行は「内容を空文字に置き換える」ことで
# 行番号を保ったまま解析対象外にする（マスク方式）。
# ---------------------------------------------------------------------------
_HEADING_RE = re.compile(r"^\s*#{1,6}(\s|$)")
_LIST_ITEM_RE = re.compile(r"^\s*([-*+]|\d+[.)])(\s|$)")
_BLOCKQUOTE_RE = re.compile(r"^\s*>")
# フェンス行の検出。開始/終了の判定では「同じ文字種（`` ` `` か `~`）かつ
# 長さが開始フェンス以上」であることを別途チェックする（``` と ~~~ の混同や、
# フェンス内に出てくる別種・より短いフェンス様の行での誤クローズを防ぐため）。
_CODE_FENCE_RE = re.compile(r"^\s*(`{3,}|~{3,})")
# 表の行判定は保守的に: 「行が `|` で始まり、`|` を2個以上含む」または
# 区切り行（`|---|---|` 的な、`-`/`:`/`|`/空白のみで構成される行）に限定する。
# 本文中にたまたま `|` が1個だけ出るケースを誤マスクしないための条件。
_TABLE_ROW_RE = re.compile(r"^\s*\|.*\|")
_TABLE_DELIMITER_RE = re.compile(r"^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$")
# YAML フロントマター（ファイル先頭の `---` ... `---`）。先頭行が単独の `---` の
# ときだけフロントマターとみなし、次の単独 `---` までをまとめてマスクする。
_FRONT_MATTER_DELIM_RE = re.compile(r"^---\s*$")
# インラインコードスパン（`code` / ``code`` のようにバッククォート1〜2個で
# 囲まれた範囲）。CommonMark 完全準拠までは不要だが、コード自体にバッククォートを
# 含む場合に使われる `` code `` 記法（主用途: コード中に単一のバッククォートが
# 含まれる場合、例: `` `code` ``）程度は拾えるようにする。そのため、ダブル
# バッククォート側の中身は「バッククォート以外」または「直後がバッククォートでない
# 単独のバッククォート」を許可する（`(?:[^`]|`(?!`))+`）。貪欲になりすぎないよう
# `` の直前で止まるようにしている。
# 文解析前に該当部分だけ同じ文字数の空白に置換する（行番号・オフセットを保つため）。
_INLINE_CODE_SPAN_RE = re.compile(r"``(?:[^`\n]|`(?!`))+``|`[^`\n]+`")
# インデントコードブロック（4スペース以上のインデント）はマスク対象に含めない。
# 通常の文中でも字下げされた引用・リストの続きなど紛らわしいケースが多く、
# 誤マスクのリスクの方が高いと判断して見送る（要検討事項として明示しておく）。
# Markdown 内のリンク・画像 `[text](url)` / `![alt](url)` の url 部分。
# alt/text 側は自然文の一部として残し、URL のみ空白化する。
_MARKDOWN_LINK_URL_RE = re.compile(r"(\]\()([^)]*)(\))")
# 画像 `![alt](url)` は alt も含めて丸ごと空白化する。alt は「image.png」「Screen Shot ...」の
# ようなファイル名であることが多く、地の文として数えると文頭の反復などの誤検知になる。
_MARKDOWN_IMAGE_RE = re.compile(r"!\[[^\]\n]*\]\([^)\n]*\)")
# 地の文に直接書かれた URL と、HTML のタグ(`<img ...>` `<details>` `</h3>` など)。
_BARE_URL_RE = re.compile(r"https?://[^\s)\]>」』）]+")
_HTML_TAG_RE = re.compile(r"</?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>\n]*)?/?>")
# かな・漢字を1字も含まない行は、日本語の地の文ではない(英文の引用、URL や画像だけの行、
# コードの断片など)。文の長さや文頭の反復の計算に入れない。
_JAPANESE_CHAR_RE = re.compile(r"[ぁ-んァ-ヶ一-龠々〆ヵヶ]")


def _mask_html_comments_in_line(line: str, in_comment: bool) -> tuple[str, bool]:
    """行内の HTML コメント（`<!-- ... -->`）を同じ長さの空白に置換する。

    複数行コメント（前の行から続いている／次の行へ続く）に対応するため、
    現在コメント内にいるかどうかを in_comment として受け取り、更新後の状態を
    返す。1行に複数のコメントが含まれる場合や、コメントの開始・終了が
    同一行内で完結する場合にも対応する。閉じタグ `-->` が見つからないまま
    行末に達した場合は、行末までを空白化しコメント継続状態のまま返す
    （CommonMark の閉じられないコメントは EOF までコメントとみなす扱いに合わせる）。
    """
    out = []
    i = 0
    n = len(line)
    while i < n:
        if in_comment:
            close = line.find("-->", i)
            if close == -1:
                out.append(" " * (n - i))
                i = n
            else:
                end = close + 3
                out.append(" " * (end - i))
                i = end
                in_comment = False
        else:
            start = line.find("<!--", i)
            if start == -1:
                out.append(line[i:])
                i = n
            else:
                out.append(line[i:start])
                i = start
                in_comment = True
    return "".join(out), in_comment


def mask_html_comments(text: str) -> str:
    """HTML コメント（`<!-- ... -->`）のみを同じ長さの空白に置換したテキストを返す。

    Markdown 構造（見出し・リスト・太字など）はマスクしない点が
    mask_markdown_structure() と異なる。構造検出器（detect_structural_ai_habits）は
    Markdown の構造そのものを検出対象とするため、構造はマスクせず、コメント内の
    誤検知だけを防ぐために使う。行数・行内オフセットは元のテキストと完全に一致させる。
    """
    lines = text.split("\n")
    masked_lines = []
    in_html_comment = False
    for line in lines:
        masked_line, in_html_comment = _mask_html_comments_in_line(line, in_html_comment)
        masked_lines.append(masked_line)
    return "\n".join(masked_lines)


def _blank_inline_code_spans(line: str) -> str:
    """行内のインラインコードスパン・Markdownリンク/画像のURL部分を
    同じ長さの空白に置換する（オフセット保持）。"""
    line = _INLINE_CODE_SPAN_RE.sub(lambda m: " " * len(m.group(0)), line)
    line = _MARKDOWN_IMAGE_RE.sub(lambda m: " " * len(m.group(0)), line)
    line = _HTML_TAG_RE.sub(lambda m: " " * len(m.group(0)), line)
    # `](url)` の url 部分だけ空白化し、`](` と `)` はそのまま残す
    # （text/alt 側は文章の一部として解析対象に残すため）。
    line = _MARKDOWN_LINK_URL_RE.sub(lambda m: m.group(1) + " " * len(m.group(2)) + m.group(3), line)
    line = _BARE_URL_RE.sub(lambda m: " " * len(m.group(0)), line)
    return line


def mask_markdown_structure(text: str) -> str:
    """見出し・リスト項目・コードブロック内・引用ブロック・表・YAMLフロントマターの行を
    空文字に置き換え、さらにインラインコードスパンとリンク/画像URLを空白化したテキストを返す。
    行数・行番号（およびインラインコードスパンの行内オフセット）は元のテキストと
    完全に一致させる（削除ではなくマスク）。

    インデントコードブロック（4スペースインデント）はマスク対象に含めない。
    箇条書きの折り返しや引用の字下げ等と見分けがつきにくく、誤マスクのリスクが
    フェンスコードブロックより高いと判断し、プロトタイプの段階では見送っている。
    """
    lines = text.split("\n")
    masked_lines = []
    in_code_block = False
    # 開いているフェンスの (文字種, 長さ)。``` と ~~~ の混同や、フェンス内に
    # 出てくる別種・より短いフェンス様の行での誤クローズを防ぐため、開始フェンスと
    # 同じ文字種かつ同じ長さ以上の行でしか閉じない（CommonMark 準拠までは行わない）。
    open_fence: tuple[str, int] | None = None
    # YAML フロントマターは「ファイル先頭行が単独の `---`」の場合のみ認識する。
    in_front_matter = False
    # HTML コメント（<!-- ... -->）。複数行にまたがる場合があるため、
    # 行をまたいで開いているかどうかを状態として持つ。
    in_html_comment = False
    for idx, line in enumerate(lines):
        if idx == 0 and _FRONT_MATTER_DELIM_RE.match(line):
            in_front_matter = True
            masked_lines.append("")
            continue
        if in_front_matter:
            masked_lines.append("")
            if _FRONT_MATTER_DELIM_RE.match(line):
                in_front_matter = False
            continue

        fence_match = _CODE_FENCE_RE.match(line)
        if fence_match:
            fence_run = fence_match.group(1)
            fence_char = fence_run[0]
            fence_len = len(fence_run)
            # CommonMark に合わせ、閉じフェンスは「フェンス文字の連続＋後続は空白のみ」の
            # 行に限定する（開始フェンスは ```python のような info string を許容するが、
            # 閉じ側でそれを許すと、フェンス内の地の文がたまたま ``` で始まっただけの
            # 行を誤ってクローズ扱いしてしまう）。
            remainder_after_fence = line[fence_match.end() :]
            is_close_eligible = remainder_after_fence.strip() == ""
            if open_fence is None:
                open_fence = (fence_char, fence_len)
            elif fence_char == open_fence[0] and fence_len >= open_fence[1] and is_close_eligible:
                open_fence = None
            # 種類・長さが一致しない行、あるいは後ろに文字が続く行は
            # 「フェンス内の地の文（例: ```内で ~~ とだけ書いた行や ```これはコード）」
            # として扱い、トグルしない。
            masked_lines.append("")
            continue
        if open_fence is not None:
            masked_lines.append("")
            continue

        line, in_html_comment = _mask_html_comments_in_line(line, in_html_comment)

        if (
            _HEADING_RE.match(line)
            or _LIST_ITEM_RE.match(line)
            or _BLOCKQUOTE_RE.match(line)
            or (_TABLE_ROW_RE.match(line) and line.count("|") >= 2)
            or _TABLE_DELIMITER_RE.match(line)
        ):
            masked_lines.append("")
            continue
        line = _blank_inline_code_spans(line)
        if line.strip() and not _JAPANESE_CHAR_RE.search(line):
            line = ""
        masked_lines.append(line)
    return "\n".join(masked_lines)



def iter_lines_with_no(text: str) -> list[tuple[int, str]]:
    """1-indexed 行番号付きで行を返す。"""
    return list(enumerate(text.splitlines(), start=1))


def find_line_no(lines: list[tuple[int, str]], needle: str, start_hint: int = 0) -> int:
    """needle を含む行番号を探す。

    start_hint（探索を始めたい行番号、例: 対象段落の開始行）以降を優先的に走査する。
    同一内容の段落が文書中に複数回登場する場合、常に先頭から検索すると
    最初に出現した行に誤帰属してしまうため、start_hint 以降の一致を優先し、
    見つからない場合のみ文書全体（start_hint より前）にフォールバックする。
    """
    for no, line in lines:
        if no >= start_hint and needle in line:
            return no
    for no, line in lines:
        if needle in line:
            return no
    return start_hint or 1


def iter_paragraphs_with_lines(
    lines: list[tuple[int, str]],
) -> list[list[tuple[int, str]]]:
    """行番号付きの行リストを、空行区切りの段落（行のグループ）に分ける。

    段落の開始行が呼び出し側に正確に分かるため、re.split(r"\\n\\s*\\n", text) と
    テキスト検索（find_line_no）による近似の line_cursor 計算に頼らずに済む。
    同一内容の段落が複数回登場しても、行番号を直接持っているので誤帰属しない。
    """
    paragraphs: list[list[tuple[int, str]]] = []
    current: list[tuple[int, str]] = []
    for no, line in lines:
        if line.strip():
            current.append((no, line))
        else:
            if current:
                paragraphs.append(current)
                current = []
    if current:
        paragraphs.append(current)
    return paragraphs


# ---------------------------------------------------------------------------
# 文分割
# ---------------------------------------------------------------------------
SENTENCE_SPLIT_RE = re.compile(r"[。！？\n]")


def split_sentences_with_lines(
    lines: list[tuple[int, str]], raw_lines_by_no: dict[int, str] | None = None
) -> list[tuple[int, str, str]]:
    """行番号付きで文を分割する（。！？で分割、行内に複数文があれば同じ行番号を割り当てる）。

    マスク済みテキスト（見出し・表マスクやインラインコードスパンの空白置換済み）と
    原文（raw_lines_by_no）を同じオフセットで同時に切り出し、
    (行番号, マスク済み文, 原文の文) の3要素タプルを返す。
    マスク処理は「行の全置換（同じ長さの空文字ではなく行そのものを""にする）」か
    「インラインコードスパンを同じ文字数の空白に置換」のいずれかで、
    どちらも文字位置を保つため、マスク済みテキストで見つけた区切り位置をそのまま
    原文の同じオフセットに適用できる。
    見出し・表・コードブロックなどマスクで丸ごと空文字になった行は、マスク済み側が
    空になり文が生成されないため、原文にレポートに出したくない構造行の内容が
    紛れ込むことはない。
    """
    sentences = []
    for no, line in lines:
        raw_line = raw_lines_by_no.get(no, line) if raw_lines_by_no else line
        bounds = []
        prev = 0
        for m in SENTENCE_SPLIT_RE.finditer(line):
            bounds.append((prev, m.start()))
            prev = m.end()
        bounds.append((prev, len(line)))
        for s, e in bounds:
            piece = line[s:e]
            if piece.strip():
                raw_piece = raw_line[s:e] if len(raw_line) >= e else piece
                sentences.append((no, piece.strip(), raw_piece.strip()))
    return sentences


# ---------------------------------------------------------------------------
# 見出し行パーサ（outline.py / terms.py で共用）
# ---------------------------------------------------------------------------


def _heading_level_and_text(line: str) -> tuple[int, str]:
    """見出し行から (レベル, 見出しテキスト) を取り出す。

    ATX見出しの closing sequence（末尾の `#` 列）は、CommonMark と同様に
    「直前に空白がある場合のみ」除去する。空白なしで見出しテキストに直接続く
    `#`（例: 「# C#」「# F#入門」）は closing sequence ではなくテキストの一部
    なので、除去してはいけない（`(?:\\s+#+)?` で closing sequence の手前に
    最低1文字の空白を要求することで区別する）。
    """
    m = re.match(r"^\s*(#{1,6})\s*(.*?)(?:\s+#+)?\s*$", line)
    if not m:
        return 0, line.strip()
    return len(m.group(1)), m.group(2).strip()


# ---------------------------------------------------------------------------
# ファイル読み込みと入力エラー処理
#
# 「文章の中身に関する判断」と「そもそも実行できない入力エラー」は区別する
# （lint.py/outline.py/terms.py 共通の方針）。前者は exit 0（判断は人間/AIに委ねる）、
# 後者（ファイル不在・ディレクトリ指定・読み取り不可・非UTF-8等）は exit 1。
# 3つのエントリスクリプトがまったく同じエラーメッセージ・判定順序で読み込めるよう、
# ここに一本化する。
# ---------------------------------------------------------------------------


def read_source_file(path: Path) -> tuple[str | None, str | None]:
    """path を UTF-8 テキストとして読み込む。

    成功時は (text, None)、失敗時は (None, error_message) を返す。
    呼び出し側は error_message を stderr に出力し、exit code 1 で終了する
    （このモジュールは exit しない。呼び出し側の CLI が判断する）。
    """
    if not path.exists():
        return None, f"エラー: ファイルが見つかりません: {path}"
    if path.is_dir():
        return None, f"エラー: ディレクトリが指定されました（ファイルを指定してください）: {path}"
    try:
        return path.read_text(encoding="utf-8-sig"), None
    except (OSError, UnicodeDecodeError) as exc:
        return None, f"エラー: ファイルを読み込めません: {path} ({exc})"
