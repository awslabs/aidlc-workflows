# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "sudachipy>=0.6.8",
#     "sudachidict-core>=20240409",
# ]
# ///
"""lint.py — AI臭い日本語文章を決定的に検出する lint スクリプト。

設計思想（HANDOFF.md 参照）:
    「AI は自分自身の AI 臭さを認識できない」→ 機械的・決定的に検出して
    人間（または AI 自身の別セッション）に突きつけ、直すかどうかの判断は
    委ねる。これは CI ゲートではなく lint であるため、検出件数に関わらず
    exit code は常に 0 にする。
    ただし、これは「文章の中身」に関する判断を保留するという意味であり、
    ファイルが読めない・存在しない・ディレクトリが指定された等の
    「そもそも lint を実行できない」入力エラーとは区別する。
    入力エラーの場合はエラーメッセージを表示し、exit code 1 で終了する。

使い方:
    uv run scripts/lint.py <file.md> [--json]

実装メモ:
    - sudachipy の Tokenizer 生成（辞書ロード）は重いので、プロセス内で
      一度だけ生成し使い回す（lazy シングルトン、textcore.get_tokenizer）。
    - 文分割は「。」「！」「？」「\\n」を区切りとする簡易実装（textcore.split_sentences_with_lines）。
      厳密な文境界解析ではないが、決定的検出のプロトタイプとしてはこれで十分。
    - sudachi トークナイザ初期化・Markdown構造マスク・文分割・ファイル読み込みなどの
      共有基盤は textcore.py にある（scripts/outline.py, scripts/terms.py と共用）。
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import re
import statistics
import sys
from pathlib import Path

from textcore import (
    Finding,
    SENTENCE_SPLIT_RE,
    _CODE_FENCE_RE,
    _HEADING_RE,
    _blank_inline_code_spans,
    _LIST_ITEM_RE,
    get_tokenizer,
    iter_lines_with_no,
    iter_paragraphs_with_lines,
    mask_html_comments,
    mask_markdown_structure,
    read_source_file,
    split_sentences_with_lines,
)

# ---------------------------------------------------------------------------
# 辞書: 禁止語・LLM 常套句カタログ
# ここは「拡張前提」のカタログ。新しい手癖フレーズに気づいたら追記していく。
# 出典: HANDOFF.md 55-62行目、および note記事「禁止語60語超」の言及。
#
# 2026-07 コーパス校正（corpus/reports/archive/deep-analysis.md §4a）による見直し:
# 実コーパス（人間103文書 + AI 81文書）で forbidden_phrase 全体の文書発火率が
# human 58〜67% > ai 30〜33% と逆転していた。単語別ヒット数を見ると、
# 「最後に」（人間48回 vs AI 2回）と「まさに」（人間24回 vs AI 0回）の2語だけで
# 人間側ヒットの63%を占めており、これらは単なる日常語であって AI 特有の
# 手癖ではないと判明したため削除した（deep-analysis.md §5 の明示的な推奨）。
# 「重要なのは」「このように」「不可欠」「ポイントは」「さて、」は人間側でも
# 一定数ヒットする（人間6〜15回 vs AI 2回前後）ため削除まではせず、
# FORBIDDEN_PHRASES_WEAK_SIGNAL に移して severity を info に格下げしている
# （検出は残すが「重大な逆向きシグナル」としては扱わない）。
# 逆に「いかがでしょうか」「大切なのは」「根本的な」「まとめると」は
# AI側ヒットの方が優勢で、当初の設計意図どおりの語として warn のまま残す。
# ---------------------------------------------------------------------------
FORBIDDEN_PHRASES: list[str] = [
    # 結論の押し付け・まとめ口調
    "と言えるでしょう",
    "と言えるだろう",
    "と言えます",
    "ということになるでしょう",
    "のではないでしょうか",
    "重要なのは",
    "大切なのは",
    "ポイントは",
    "結論から言うと",
    "結論として",
    "いかがでしたか",
    "いかがでしょうか",
    # 「最後に」はコーパス校正で削除（人間48回 vs AI 2回、日常語であってAI手癖ではない）
    "まとめると",
    "総じて",
    # 過剰な強調・持ち上げ
    "非常に重要",
    "極めて重要",
    "言うまでもなく",
    "言うまでもありません",
    # 「まさに」はコーパス校正で削除（人間24回 vs AI 0回、日常語であってAI手癖ではない）
    "まさしく",
    # 定型導入・空疎な接続
    "さて、",
    "それでは、",
    "このように",
    "このような中",
    "ここで注目したいのは",
    "見ていきましょう",
    "紹介していきます",
    "解説していきます",
    "深掘りしていきます",
    # 予防線・免責的な言い回し
    "一概には言えません",
    "個人差がありますが",
    "あくまで一例ですが",
    # 正面から系（出典: k16shikano の日本語技術文書規範。中身の代わりに姿勢だけを宣言する）
    "正面から扱う",
    "正面から見る",
    "正面から書く",
    "正面から立てる",
    "正面から回収する",
    # 空虚な形容（出典: k16shikano の日本語技術文書規範。主張の中身を説明せず強調・網羅感だけ付ける）
    "不可欠",
    "核心的",
    "鍵となる",
    "根本的な",
    "多角的",
    "包括的",
    "総合的",
    # 空虚な動詞・予告口調（出典: k16shikano の日本語技術文書規範。何をどう書いたか示さず終わる）
    "掘り下げる",
    "深掘りする",
    "言語化する",
    "について見ていく",
    "を探求する",
]

# コーパス校正で「人間側でも一定数ヒットするため弱いシグナル」と判定した語。
# 削除はせず検出は残すが、severity を warn ではなく info に下げる
# （deep-analysis.md §4a: 人間6〜15回 vs AI 2回前後、比率は逆転していないが
# 絶対数として人間の日常的な使用がそれなりにある語）。
FORBIDDEN_PHRASES_WEAK_SIGNAL: set[str] = {
    "重要なのは",
    "このように",
    "不可欠",
    "ポイントは",
    "さて、",
}

# ---------------------------------------------------------------------------
# 辞書: 翻訳調パターン（英語直訳っぽい構文）
# ---------------------------------------------------------------------------
# 「することができる」「することが可能」は、2026-10 の測定で生成AI以前の人間の文書(Qiita 2022・llm-jp)の
# ほうが生成AIの文書より多く使っており、生成AIらしさの印にならない。冗長さの指摘として
# 読みにくそうな箇所の検査の translationese_morph(品詞列で「〜ことができる」を拾う)だけで扱う。
TRANSLATIONESE_PATTERNS: list[str] = [
    r"と言えるだろう",
    r"という点で",
    r"という観点(から|で)",
    r"にとって(重要|不可欠)",
    r"を持つ(こと|存在)",
    r"することによって",
    r"であることは間違いない",
    r"に他ならない",
]

# 段落頭に来ると「AI が構成を接続詞で誤魔化しがち」な語
PARAGRAPH_CONJUNCTIONS: list[str] = [
    "しかし",
    "また",
    "そして",
    "そのため",
    "さらに",
    "つまり",
    "一方",
    "一方で",
    "このように",
    "なぜなら",
    "したがって",
    "ただし",
]

# 否定→肯定対比の手癖パターン（正規表現）
ANTITHESIS_PATTERNS = [
    re.compile(r"ではなく、?.{0,30}"),
    re.compile(r"だけでなく.{0,10}も"),
]

# ---------------------------------------------------------------------------
# 検出器の閾値パラメータ（デフォルト値付きモジュールレベル定数）
#
# 各検出器のヒット判定に使う「回数/割合/最低サンプル数」の閾値を、関数内の
# リテラルではなくここに集約する。scripts/calibrate.py が閾値スイープで
# パラメータを変えて検出器を直接呼べるようにするための整理であり、
# ここに定義した値はすべて元のリテラルと同じ（CLI 挙動・検出結果は完全に不変）。
# 各検出関数は同名のキーワード引数でこれらをデフォルト値として受け取り、
# 呼び出し側から上書きできる。
# ---------------------------------------------------------------------------
ANTITHESIS_REPETITION_THRESHOLD = 3
# 2026-07 コーパス校正2（corpus/reports/antithesis-recalibration.md）: 絶対回数閾値
# （3回以上）だけで severity=critical を出す旧仕様は、長文書（例: 12,000文規模の
# 白書）では検出数が薄まって比率としてはノイズ同然でも critical 連打になる一方、
# 質の高い書き手の修辞技法（誤解を先に否定してから定義する等）にも無差別に発火して
# いた。実測（human quality:high、web+aozora、n=81）では絶対回数閾値ヒット率が
# 23.5%（19文書）に達したが、そのヒット文書の「検出数/総文数」比率分布は中央値
# 1.5%・90パーセンタイル2.4%・最大4.6%にとどまる。一方 AI 側のヒット文書
# （hits>=3、n=48）の比率分布は中央値8.3%・最小でも2.65%と、human とほぼ重ならない
# 分布を示した。この比率を使い、絶対回数閾値は維持しつつ severity を3段階化する:
# ratio < ANTITHESIS_RATE_INFO_BELOW は info（薄い比率＝人間の技法との区別がつかない）、
# ratio >= ANTITHESIS_RATE_CRITICAL_ABOVE は critical（高頻度＝真陽性の実測あり）、
# その中間は warn。閾値0.02/0.03で human 全体の critical化率は4.9%（<5%目標達成）。
# ただし tech ジャンルのみ human critical化率が11.1%と高く出たため、
# GENRE_PROFILES["tech"]["antithesis_rate_critical_above"] で0.045に緩めている
# （tech human critical化率は0%に低下、AI側もcritical 9/84 + warn 6/84 で検出は維持）。
ANTITHESIS_RATE_INFO_BELOW = 0.02
ANTITHESIS_RATE_CRITICAL_ABOVE = 0.03
SENTENCE_VARIANCE_MIN_SENTENCES = 5
SENTENCE_VARIANCE_CV_THRESHOLD = 0.25
NOMINAL_ENDING_MIN_SENTENCES = 5
# 2026-07 コーパス校正で検出方向を反転（corpus/reports/archive/deep-analysis.md §3, §4b）。
# 体言止めは AI の手癖ではなく人間の修辞技法で、essayジャンルでは人間60%が使う一方
# AIは0%（essay同ジャンル比較、n=50/37）。「多用」を警告する検出器としては
# 前提が誤りだったため、「長文なのに体言止めが1つもない」ことを人間的修辞の
# 欠如（AIらしさの一側面）として検出する方向に反転した。
# NOMINAL_ENDING_RATIO_THRESHOLD は「この比率以下なら欠如とみなす」閾値
# （反転前は「以上で警告」だった）。NOMINAL_ENDING_MIN_CHARS は
# 「~2000字ビンで human 67% vs ai 0%」という長さ依存の知見を踏まえたガード
# （短文書は人間でも体言止めがゼロなことが珍しくないため対象外にする）。
NOMINAL_ENDING_RATIO_THRESHOLD = 0.0
NOMINAL_ENDING_MIN_CHARS = 2000
PARAGRAPH_CONJ_MIN_PARAGRAPHS = 3
PARAGRAPH_CONJ_RATIO_THRESHOLD = 0.3
UNIFORM_PARAGRAPH_MIN_PARAGRAPHS = 4
UNIFORM_PARAGRAPH_CV_THRESHOLD = 0.15
# NESTED_ATTRIBUTIVE_THRESHOLD は 2026-07 コーパス校正で検出器ごと削除（弁別力なし）。
BURSTINESS_MIN_TOKENIZED = 6
# 2026-07 コーパス校正（corpus/reports/archive/sweep_low_burstiness.md）: 旧値-0.62では
# human/aiとも0%/0%で「無反応」だった。sweepで-0.9〜-0.2を走査した結果、
# -0.24で human FP率2.4%・AI検出率100.0%と、他の統計系検出器の中では唯一
# 弁別力を示したため、この値を採用する。ただしAI標本はn=3と極めて小さく、
# コーパス拡充後に再sweepして確定させる必要がある暫定値。
# 2026-10 再校正: 画像・URL・HTML タグ・かな漢字を含まない行を本文から外す前処理に変えたため、
# 人間の文書の文長のばらつきが小さく出るようになった(英文や URL の行が長短の幅を作っていた)。
# 生成AI以前の人間の文書400本(Qiita 2022・llm-jp)と生成AIの文書100本で走査し、
# -0.30 で人間 21%・17%、生成AI 63%(旧前処理・旧閾値 -0.24 では 17%・28%、67%)。
BURSTINESS_THRESHOLD = -0.30
AUTOCORR_MIN_XS = 4
AUTOCORR_THRESHOLD = 0.6
# 2026-07 コーパス校正で閾値を大幅に引き上げ、severityも格下げ（deep-analysis.md
# §3, §4）。文頭反復は human_web 93% vs ai 41%（文書発火率）と人間側で
# 圧倒的に多く、essay同ジャンルでも人間92% vs AI35%と逆転していた。
# 人間の書き手が意図的にリズムとして文頭を反復する技法と、AIの反復癖を
# この検出器だけでは区別できないため、閾値を3→6に引き上げて「明らかな
# 過剰反復」だけを拾うようにし、severityもwarnからinfoに下げて
# 判断材料の提示にとどめる。
NGRAM_LEAD_REPEAT_THRESHOLD = 6
NGRAM_TEMPLATE_MIN_COUNT = 6
NGRAM_TEMPLATE_RATIO_THRESHOLD = 0.4
LEXDIV_MIN_TOKENS = 30
TTR_THRESHOLD = 0.45
MTLD_THRESHOLD = 40
# 2026-07 コーパス校正（corpus/reports/archive/length_analysis.md）: TTRが意味のある
# 差を示すのは文書長4000字以上のビンのみ（それ未満は human/ai とも0%で無意味）。
LEXDIV_MIN_DOC_CHARS = 4000

# ---------------------------------------------------------------------------
# low_specificity（具体性/一般論臭）検出器のパラメータ
#
# Phase 3（HANDOFF.md 参照）: 「固有名詞・数値・実例がなく、抽象名詞ばかりの
# 段落」は、表層の禁止語や統語パターンとは別種のAI臭（＝素材不足のサイン）で、
# 既存の検出器では拾えない。段落単位で具体性シグナルを合成スコア化し、
# 閾値未満なら info で指摘する。
#
# 合成式: score = 固有名詞密度*重み + 数値密度*重み + 例示マーカー加点
#                - 抽象名詞率*重み
# 「密度」「率」は内容語（名詞/動詞/形容詞/副詞）数に対する割合。
# 閾値・重みはこの時点では暫定値であり、scripts/calibrate.py の corpus/ 校正
# （sweep --detector low_specificity）で確定させる前提（このコミット時点の値も
# 校正済み。閾値変更の経緯は corpus/reports/archive/sweep_low_specificity.md 参照）。
# ---------------------------------------------------------------------------
# 2026-07 コーパス校正（corpus/reports/archive/sweep_low_specificity.md、grid search
# ログはコミットしていないが手順は本ファイルのコメントに残す）: 当初の重み
# （proper=3.0, numeric=4.0, abstract=1.0, threshold=0.05）は human FP率が
# 46.6%（!）に達し、実用にならなかった。原因は「固有名詞も数値も例示マーカーも
# 一切ない段落」が多数を占め、それらが score=0 ちょうどに集中して閾値0付近で
# 一斉に発火していたため。閾値を負に大きくズラして「明確に抽象名詞が勝っている」
# 段落だけを拾うよう調整し、あわせて重みを小さくして score の分散を滑らかにした。
# 現在値は human FP率 3.9%（<5%目標達成）、AI全体検出率 7.4%、
# claude-haiku-4-5 サブセット検出率 5.9%（n=34）。
# 弁別力自体は他の校正済み検出器と比べて弱いが、コーパス標本数が小さい
# （human n=103, ai n=81）中での探索結果であり、コーパス拡充後に再校正すべき
# 暫定値として明示しておく。
LOW_SPECIFICITY_MIN_CHARS = 80
LOW_SPECIFICITY_MIN_CONTENT_WORDS = 15
LOW_SPECIFICITY_PROPER_NOUN_WEIGHT = 1.0
LOW_SPECIFICITY_NUMERIC_WEIGHT = 1.0
LOW_SPECIFICITY_EXAMPLE_MARKER_BONUS = 0.1
LOW_SPECIFICITY_ABSTRACT_NOUN_WEIGHT = 1.5
LOW_SPECIFICITY_SCORE_THRESHOLD = -0.15

# 形式名詞・抽象名詞のカタログ（拡張前提）。出典: HANDOFF.md の一般論臭の説明、
# および k16shikano の日本語技術文書規範の「空句」。辞書形（dictionary_form）で比較する。
#
# 「こと」「もの」「の」はコーパス校正で除外した: 出現頻度が極端に高く
# （human 82/103文書、ai 72/81文書で出現）、機能語に近い一般的な形式名詞のため
# 弁別力がない（corpus/reports/archive/sweep_low_specificity.md 参照）。
ABSTRACT_NOUN_WORDS: set[str] = {
    "側面",
    "観点",
    "重要性",
    "可能性",
    "あり方",
    "存在",
    "意味",
    "本質",
    "価値",
    "意義",
    "課題",
    "問題",
    "要素",
    "要因",
    "背景",
    "傾向",
    "姿勢",
    "視点",
    "概念",
    "特徴",
    "性質",
    "状況",
    "状態",
    "変化",
}

# 例示・具体化のマーカー語（段落中にあれば具体性の加点にする）
EXAMPLE_MARKER_WORDS: list[str] = [
    "たとえば",
    "例えば",
    "実際に",
    "実際には",
    "具体的には",
    "具体例として",
    "一例として",
    "先日",
    "昨日",
    "現に",
    "実例として",
]

# 数値・日付・単位付き数量の検出（半角/全角数字を単位・助数詞と一緒に拾う）
NUMERIC_QUANTITY_RE = re.compile(
    r"[0-9０-９]+"
    r"(年代|年間|世紀|年|月|日|時間|時|分|秒|人|円|%|％|kg|km|cm|mm|g|m|回|件|個|つ|割|倍|台|社|名|冊|本|杯|軒)?"
)

# ---------------------------------------------------------------------------
# --genre プロファイル（2026-07 コーパス校正で新設）
#
# deep-analysis.md はジャンル別（essay/tech/business）に人間・AI差の大きさが
# 異なることを示した: essay は nominal_ending・repeated_sentence_lead の逆転が
# 最も強く出るジャンル、tech は人間の書き手も見出し・箇条書き・太字を多用する
# ため AI との差が縮む傾向にある。business はコーパスが薄く
# （人間側n=10、AI側n=0）、単独でのプロファイル確定は時期尚早なので、
# 指示どおり tech と同じ値を使う。
# genre 未指定（デフォルト）はどのジャンルにも偏らない共通の保守的閾値
# （モジュール定数のデフォルト値そのもの）を使う。
# ---------------------------------------------------------------------------
GENRE_PROFILES: dict[str, dict] = {
    "essay": {
        # essayジャンルは体言止め欠如シグナルが最も強く出る（人間60% vs AI 0%）ため、
        # 共通閾値よりやや短い文書長からでも欠如を拾えるようにする。
        "nominal_min_chars": 1500,
        # essayも文頭反復の逆転が大きい（人間92% vs AI35%）ジャンルだが、
        # 依然として人間の意図的反復技法との区別はつかないため、共通閾値より
        # わずかに低いだけに留める（過検出を避ける）。
        "lead_repeat_threshold": 5,
        # 読みにくそうな箇所の検査（--reading-load）の一文長の目安。readability-sweep.md の
        # 候補1（文長）で、essay だけがジャンル別FP率6.7%と唯一5%を超えた
        # （tech/business はいずれも0.0%）。エッセイの長い一文は書き手の呼吸で
        # あることが多いため、共通の90字より緩める。
        "reading_load_sentence_max_chars": 110,
    },
    "tech": {
        # tech記事は人間もAIも見出し・箇条書き構成に寄るため差が縮む。
        # 誤検知を避けるため共通閾値よりやや保守的（緩め）にする。
        "nominal_min_chars": 3000,
        "lead_repeat_threshold": 7,
        # antithesis_repetition の2026-07コーパス校正2（corpus/reports/
        # antithesis-recalibration.md）: tech ジャンルは共通閾値0.03だと
        # human quality:high の critical化率が11.1%（zennの技術記事2本）と
        # 目標の5%を超えたため、0.045に緩める（tech human critical化率0%に低下、
        # AI側もcritical 9/84 + warn 6/84 で検出は維持）。
        "antithesis_rate_critical_above": 0.045,
    },
    # business は 2026-07 の実地校正（corpus/reports/business-calibration.md）で
    # 実測した。人間側コーパスは corpus/human/web の biz-* 10件のみと薄いため、
    # 「AI の文書でよく発火する検出器を厳しくする」方向の調整はせず、事業文書の正当な慣習
    # （箇条書き・太字強調・定型見出し・フェーズ表現）と衝突しうる検出器は
    # 無効化するに留めている（詳細は上記レポート参照）。
    #   - nominal_min_chars: tech と同値（3000）を維持。実測では business
    #     コーパス（人間・AIとも）で nominal_ending が閾値に関わらず一度も
    #     発火しなかった（文書が短くAI/人間どちらの誤検知リスクも無い）ため、
    #     変更する実測的根拠がない。
    #   - lead_repeat_threshold: tech と同値（7）を維持。実測でこの値が
    #     human_business の誤検知（デフォルト閾値6で20%→閾値7で10%）を
    #     半減させつつ ai_business の検出率（4%）を落とさない局所最適点。
    #   - disabled_categories: high_bullet_ratio・high_bold_density・
    #     boilerplate_heading・numbered_phase_structure は、事業文書
    #     （報告書・提案書・議事録等）で箇条書き・太字強調・「まとめ」等の
    #     定型見出し・フェーズ/ステップ表現が正当に多用されるため、
    #     AI側の発火率がどうであれ business ジャンルでは無効化する。
    #     これらはいずれも EXPERIMENTAL_CATEGORIES に属し、デフォルトでは
    #     既に出力されない（--experimental 指定時のみ影響する）が、将来
    #     デフォルト化された場合の誤検知を防ぐため、ジャンル側でも明示的に
    #     無効化しておく。
    "business": {
        "nominal_min_chars": 3000,
        "lead_repeat_threshold": 7,
        "disabled_categories": {
            "high_bullet_ratio",
            "boilerplate_heading",
            "numbered_phase_structure",
        },
    },
}


def format_related_lines(related_lines: list[int]) -> str:
    """related_lines を人間可読の「対応箇所: L12, L34, ...」形式に整形する（重複除去・昇順ソート）。"""
    uniq_sorted = sorted(set(related_lines))
    return "対応箇所: " + ", ".join(f"L{n}" for n in uniq_sorted)


# ---------------------------------------------------------------------------
# --baseline 差分モード
#
# スキルの利用フローは「lint → 台帳に直した/残すを仕分け → 修正 → 再lint →
# 新規findingが出なくなるまで繰り返す」という収束駆動ループになっている。
# ループのたびに全件を目視で見比べるのは負担が大きいので、前回の --json 出力
# （baseline）と今回の結果を比較し、resolved（解消）/ new（新規）/
# persisting（継続）に分類する。
#
# 同一性キーの設計判断:
#   行番号は修正のたびに増減してズレるため、キーに含めない
#   （同じ指摘でも直した箇所より後ろの行が繰り上がるだけで「新規」扱いに
#   なってしまう）。excerpt は形態素境界のわずかな変化や、直した箇所の
#   前後の空白差などで完全一致しなくなることがあるため、正規化
#   （空白除去）した上で先頭 N 文字の前方一致とする。カテゴリ名は
#   検出器の種類そのものなので、そのまま等価比較に使う。
#   これは完全に正確な同一性判定ではないが、実装が単純で、
#   「同じ場所・同じ理由の指摘かどうか」の近似としては十分安定する。
# ---------------------------------------------------------------------------
_BASELINE_KEY_EXCERPT_PREFIX_LEN = 20

# 文書全体の統計量（burstiness・変動係数・TTR/MTLD 等）を excerpt に直接埋め込んでいる
# カテゴリ。これらは1文書につき高々1件しか出ない「集計そのもの」の finding であり、
# excerpt が「burstiness=-0.623 (...)」のように計算結果の数値そのものなので、
# 無関係な編集で文書の統計量がわずかに変化しただけで excerpt 文字列が変わり、
# 同一性キーに含めると「解消」＋「新規」の偽ペアが発生してしまう。
# このグループはカテゴリ名だけをキーにする（1文書1件が前提なので情報の欠落もない）。
#
# 一方、nominal_ending・repeated_sentence_lead・repeated_syntax_template・
# paragraph_lead_conjunction・antithesis_repetition は「文書全体集計型」ではあるが、
# excerpt 自体は実際にマッチした原文（体言止めの文末・反復した文頭など）であり、
# 数値は detail 側にしか出てこない（同一性キーは detail を見ていない）。
# これらは1文書内に複数の異なる該当箇所を持つのが普通なので、カテゴリ名だけに
# 潰さず、従来どおり excerpt の前方一致キーを使う方が精度が高い。
_CATEGORY_ONLY_KEY_CATEGORIES = {
    "low_burstiness",
    "high_length_autocorrelation",
    "low_sentence_variance",
    "uniform_paragraph_structure",
    "low_lexical_diversity_ttr",
    "low_lexical_diversity_mtld",
}


def _normalize_excerpt_for_key(excerpt: str) -> str:
    """excerpt を同一性キー用に正規化する（空白類を除去）。"""
    return re.sub(r"\s+", "", excerpt or "")


def _finding_identity_key(category: str, excerpt: str) -> tuple[str, str]:
    """(category, 正規化excerptの前方一致キー) を返す。行番号は含めない。
    _CATEGORY_ONLY_KEY_CATEGORIES に該当するカテゴリは excerpt を無視し、
    カテゴリ名のみをキーにする（理由は上のコメント参照）。
    """
    if category in _CATEGORY_ONLY_KEY_CATEGORIES:
        return (category, "")
    normalized = _normalize_excerpt_for_key(excerpt)
    return (category, normalized[:_BASELINE_KEY_EXCERPT_PREFIX_LEN])


def validate_baseline_data(baseline_data) -> tuple[dict | None, list[str]]:
    """--baseline で読み込んだ JSON の形を検証する。

    スキーマが想定外（トップレベルが dict でない、"findings" が配列でない、
    配列内の要素が dict でない等）でも compute_baseline_diff() をクラッシュ
    させたくないため、ここで軽量な検証を行い、
    - 完全に想定外の形なら (None, [警告メッセージ]) を返し、呼び出し側は
      baseline 比較そのものを諦めて通常の lint 実行にフォールバックする
      （graceful degradation。lint はそもそも CI ゲートではないので、
      baseline ファイルの不備で実行全体を落とすべきではない）
    - "findings" 配列の一部の要素だけが dict でない場合は、その要素だけを
      読み飛ばして残りで比較を続行する
    """
    warnings: list[str] = []
    if not isinstance(baseline_data, dict):
        warnings.append(
            "--baseline の内容が JSON オブジェクトではありません。baseline との比較はせずに通常のlintを実行します。"
        )
        return None, warnings

    findings_raw = baseline_data.get("findings")
    if not isinstance(findings_raw, list):
        warnings.append(
            "--baseline に 'findings' 配列が見つかりません。baseline との比較はせずに通常のlintを実行します。"
        )
        return None, warnings

    valid_findings = []
    skipped = 0
    for item in findings_raw:
        # dict であることに加え、_finding_identity_key() が参照するフィールドの型も
        # ここで検証する（category が非文字列だと set 判定、excerpt が非文字列だと
        # re.sub がクラッシュするため。JSON としては valid でも型が壊れた baseline
        # は要素単位で読み飛ばす）。
        if (
            isinstance(item, dict)
            and isinstance(item.get("category"), str)
            and isinstance(item.get("excerpt"), str)
        ):
            valid_findings.append(item)
        else:
            skipped += 1
    if skipped:
        warnings.append(
            f"--baseline の findings 配列内に不正な要素が{skipped}件あったため読み飛ばしました。"
        )
    return {"findings": valid_findings}, warnings


def compute_baseline_diff(
    findings: list[Finding], baseline_data: dict
) -> tuple[list[dict], dict[str, int]]:
    """今回の findings と、前回の --json 出力（baseline_data、事前に
    validate_baseline_data() を通した想定）を比較する。

    各 Finding の `.status` を "new"（今回のみ）または "persisting"
    （両方に存在）に破壊的に設定する。baseline にしかない finding は
    「resolved（解消）」として別途リストで返す（対応する現在の Finding
    オブジェクトが存在しないため、baseline の生 dict のまま返す）。

    多重集合としてマッチングする（同じキーの finding が複数あっても、
    件数分だけ 1 対 1 で対応付ける）ため、同じ指摘が複数箇所にある
    ケースでも resolved/persisting の件数がズレない。
    """
    from collections import defaultdict

    baseline_findings = baseline_data.get("findings", [])
    baseline_by_key: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for bf in baseline_findings:
        key = _finding_identity_key(bf.get("category", ""), bf.get("excerpt", ""))
        baseline_by_key[key].append(bf)

    for f in findings:
        key = _finding_identity_key(f.category, f.excerpt)
        bucket = baseline_by_key.get(key)
        if bucket:
            bucket.pop(0)
            f.status = "persisting"
        else:
            f.status = "new"

    resolved = [bf for bucket in baseline_by_key.values() for bf in bucket]

    summary = {
        "resolved": len(resolved),
        "new": sum(1 for f in findings if f.status == "new"),
        "persisting": sum(1 for f in findings if f.status == "persisting"),
    }
    return resolved, summary



# ---------------------------------------------------------------------------
# 各検出器
# ---------------------------------------------------------------------------


def _raw_or_masked(raw_lines_by_no: dict[int, str] | None, no: int, fallback: str) -> str:
    """行番号に対応する原文行を返す（無ければマスク済み行にフォールバック）。"""
    if raw_lines_by_no is None:
        return fallback
    return raw_lines_by_no.get(no, fallback)


_KATAKANA_RE = re.compile(r"[ァ-ヶー]")
_KANJI_RE = re.compile(r"[一-龠々]")


def _phrase_positions(line: str, phrase: str) -> list[int]:
    """phrase が語として現れる位置をすべて返す。カタカナで始まる語の直前がカタカナ、
    漢字で始まる語の直前が漢字のときは、別の語の一部(「エンドポイントは」の「ポイントは」、
    「包括的経済連携協定」の前に漢字が続く「日英包括的」など)とみなして数えない。"""
    out = []
    head = phrase[0]
    for m in re.finditer(re.escape(phrase), line):
        prev = line[m.start() - 1] if m.start() > 0 else ""
        if prev and ((_KATAKANA_RE.match(head) and _KATAKANA_RE.match(prev))
                     or (_KANJI_RE.match(head) and _KANJI_RE.match(prev))):
            continue
        out.append(m.start())
    return out


def detect_forbidden_phrases(
    lines: list[tuple[int, str]], raw_lines_by_no: dict[int, str] | None = None
) -> list[Finding]:
    """マスク済み行（コードスパン等を空白化したテキスト）でパターンマッチし、
    excerpt は同じオフセットで原文行から切り出す（マスクは解析専用、表示は原文）。
    """
    findings = []
    for no, line in lines:
        raw_line = _raw_or_masked(raw_lines_by_no, no, line)
        for phrase in FORBIDDEN_PHRASES:
            for idx in _phrase_positions(line, phrase):
                start = max(0, idx - 10)
                end = idx + len(phrase) + 10
                excerpt = raw_line[start:end] if len(raw_line) >= end else line[start:end]
                is_weak_signal = phrase in FORBIDDEN_PHRASES_WEAK_SIGNAL
                severity = "info" if is_weak_signal else "warn"
                detail = f"AI の書いた文章によく出る言い回し「{phrase}」"
                if is_weak_signal:
                    detail += "（人間の文書にもよく出る語なので、弱い疑い）"
                findings.append(
                    Finding(
                        line=no,
                        category="forbidden_phrase",
                        excerpt=excerpt.strip(),
                        severity=severity,
                        detail=detail,
                    )
                )
    return findings


def detect_translationese(
    lines: list[tuple[int, str]], raw_lines_by_no: dict[int, str] | None = None
) -> list[Finding]:
    findings = []
    for no, line in lines:
        raw_line = _raw_or_masked(raw_lines_by_no, no, line)
        for pat in TRANSLATIONESE_PATTERNS:
            for m in re.finditer(pat, line):
                start = max(0, m.start() - 10)
                end = m.end() + 10
                excerpt = raw_line[start:end] if len(raw_line) >= end else line[start:end]
                findings.append(
                    Finding(
                        line=no,
                        category="translationese",
                        excerpt=excerpt.strip(),
                        severity="info",
                        detail="英語の構文をなぞった翻訳調の言い回しの疑い",
                    )
                )
    return findings


def detect_antithesis_repetition(
    lines: list[tuple[int, str]],
    raw_lines_by_no: dict[int, str] | None = None,
    threshold: int = ANTITHESIS_REPETITION_THRESHOLD,
    rate_info_below: float = ANTITHESIS_RATE_INFO_BELOW,
    rate_critical_above: float = ANTITHESIS_RATE_CRITICAL_ABOVE,
) -> list[Finding]:
    """「〜ではなく、〜」「〜だけでなく〜も」を文書全体で数え、threshold回（デフォルト3回）
    以上なら反復として検出する。

    2026-07 コーパス校正2（corpus/reports/antithesis-recalibration.md、モジュール定数
    ANTITHESIS_RATE_INFO_BELOW / ANTITHESIS_RATE_CRITICAL_ABOVE のコメントも参照）:
    出現ごとに severity=critical を付けていた旧仕様は、長文書での薄い頻度でも
    critical が連打されノイズ化する一方、人間の意図的な修辞技法にも無差別に発火して
    いた。「検出数/総文数」の比率で severity を3段階化する: 比率が低ければ info
    （人間の技法との区別がつかない参考情報）、高ければ critical（実測で真陽性が
    多い高頻度パターン）、その中間は warn。

    どの文同士が反復としてカウントされたか追えるよう、全ヒット行番号を
    related_lines / detail の両方に含める。excerpt は原文から切り出す。
    """
    hits: list[tuple[int, str, str]] = []  # (line_no, matched_excerpt(raw), pattern_name)
    for no, line in lines:
        raw_line = _raw_or_masked(raw_lines_by_no, no, line)
        for pat in ANTITHESIS_PATTERNS:
            for m in re.finditer(pat, line):
                excerpt = raw_line[m.start() : m.end()] if len(raw_line) >= m.end() else m.group(0)
                hits.append((no, excerpt, pat.pattern))

    findings = []
    if len(hits) >= threshold:
        # 文書全体の総文数に対する検出数の比率で severity を決める（絶対回数の閾値
        # 判定とは別に、比率が文書の長さに関わらず一貫した「密度」の指標になる）。
        total_sentences = len(split_sentences_with_lines(lines, raw_lines_by_no))
        ratio = len(hits) / total_sentences if total_sentences else 0.0
        if ratio < rate_info_below:
            severity = "info"
        elif ratio >= rate_critical_above:
            severity = "critical"
        else:
            severity = "warn"

        all_lines = [no for no, _, _ in hits]
        related = format_related_lines(all_lines)
        for no, text, patname in hits:
            findings.append(
                Finding(
                    line=no,
                    category="antithesis_repetition",
                    excerpt=text.strip(),
                    severity=severity,
                    detail=(
                        f"否定→肯定対比パターンが文書内で{len(hits)}回検出（閾値{threshold}回以上、"
                        f"総文数に対する比率={ratio:.1%}）。{related}"
                    ),
                    related_lines=all_lines,
                )
            )
    return findings



# 文末を打ち消しで終える文(「〜ではない。」「〜わけではない。」)の多用。GPT 系の文書に特に多い。
# 2026-10 の測定(手元の評価用データ):文書内に4回以上あったのは、生成AI以前の人間の文書
# 400本で0本、Claude・Gemini の文書65本で0本、GPT 系の文書35本で22本。「〜ではないでしょうか」
# 「〜ではないか」のような問いかけ・推量は数えない(人間の文書に多く、打ち消しではないため)。
NEGATION_END_RE = re.compile(r"(?:ではない|ではありません|じゃない|わけではない|わけではありません|わけじゃない)(?:のです|んです|のだ)?$")
NEGATION_REPETITION_THRESHOLD = 4


def detect_negation_repetition(
    lines: list[tuple[int, str]],
    raw_lines_by_no: dict[int, str] | None = None,
    threshold: int = NEGATION_REPETITION_THRESHOLD,
) -> list[Finding]:
    """文末を打ち消しで終える文を文書全体で数え、threshold 回以上なら多用として検出する。"""
    hits = []
    for no, sent, raw in split_sentences_with_lines(lines, raw_lines_by_no):
        body = sent.strip().rstrip("。．")
        if NEGATION_END_RE.search(body):
            hits.append((no, (raw or sent).strip()))
    findings = []
    if len(hits) >= threshold:
        all_lines = [no for no, _ in hits]
        related = format_related_lines(all_lines)
        for no, text in hits:
            findings.append(Finding(
                line=no, category="negation_repetition", excerpt=text[:60], severity="warn",
                detail=f"文末を打ち消しで終える文が文書内で{len(hits)}回(閾値{threshold}回以上)。{related}",
                related_lines=all_lines,
            ))
    return findings


def detect_low_sentence_length_variance(
    sentences: list[tuple[int, str, str]],
    threshold: float = SENTENCE_VARIANCE_CV_THRESHOLD,
    min_sentences: int = SENTENCE_VARIANCE_MIN_SENTENCES,
) -> list[Finding]:
    """文長（文字数）の変動係数（CV = 標準偏差/平均）が閾値未満なら
    「文長が均質すぎる = リズムが単調 = AI臭い」として警告する。
    最低5文以上ないと統計的に意味がないので判定しない。
    """
    lengths = [len(s) for _, s, _ in sentences if len(s) > 0]
    if len(lengths) < min_sentences:
        return []
    mean = statistics.mean(lengths)
    if mean == 0:
        return []
    stdev = statistics.pstdev(lengths)
    cv = stdev / mean
    if cv < threshold:
        first_line = sentences[0][0] if sentences else 1
        return [
            Finding(
                line=first_line,
                category="low_sentence_variance",
                excerpt=f"文数={len(lengths)}, 平均文長={mean:.1f}字, 変動係数={cv:.3f}",
                severity="warn",
                detail=f"文の長さのばらつきが小さい（変動係数が閾値{threshold}未満）。文の長さがそろいすぎている疑い",
            )
        ]
    return []


NOUN_ENDING_POS = {"名詞"}
TRAILING_SYMBOL_POS = {"補助記号", "空白"}

# 語彙多様性計測の対象とする内容語 POS
CONTENT_WORD_POS = {"名詞", "動詞", "形容詞", "副詞"}

# 「無生物主語+他動詞」判定で「主語になっても不自然でない代名詞」として許可する語。
# sudachipy は「この事実」「そのこと」を単一形態素にせず複数形態素
# （例:「この」+「事実」）に分割するため、単一形態素の表層文字列と比較する
# 判定では到達不可能。単一形態素で成立する語だけをここに残し、
# 複数形態素にまたがる語は ABSTRACT_PRONOUN_PHRASES で別途、
# 隣接形態素を連結して比較する。
ABSTRACT_PRONOUNS = {"これ", "それ", "あれ", "それら"}
# 2形態素にまたがる指示表現（連結した表層文字列で比較する）
ABSTRACT_PRONOUN_PHRASES = {"この事実", "そのこと"}
# 述語側: 直訳調でよく使われる他動詞的な動詞（辞書は拡張前提）
TRANSITIVE_SMELL_VERBS = {
    "もたらす",
    "示す",
    "意味する",
    "証明する",
    "生み出す",
    "反映する",
    "示唆する",
    "物語る",
    "浮き彫りにする",
    "後押しする",
}


@dataclasses.dataclass
class TokenizedSentence:
    line: int
    text: str  # マスク済みテキスト（形態素解析・パターンマッチ用）
    morphemes: list  # sudachipy.MorphemeList の要素（text を解析した結果）
    raw_text: str = ""  # 原文（レポートのexcerpt表示は必ずこちらを使う）


def tokenize_sentences(sentences: list[tuple[int, str, str]]) -> list[TokenizedSentence]:
    """文ごとに一度だけ形態素解析し、以後の検出器で使い回す（辞書ロードとトークナイズの
    コストを最小化するための共有キャッシュ）。
    形態素解析はマスク済みテキスト（text）に対して行うが、レポート表示用の原文
    （raw_text、インラインコードスパンのバッククォート内文字列などを含む）も保持し、
    excerpt はそちらから切り出す。
    """
    tokenizer = get_tokenizer()
    from sudachipy import SplitMode

    result = []
    for no, sent, raw_sent in sentences:
        if not sent:
            continue
        morphemes = list(tokenizer.tokenize(sent, SplitMode.C))
        result.append(TokenizedSentence(line=no, text=sent, morphemes=morphemes, raw_text=raw_sent or sent))
    return result


def _strip_leading_symbols(morphemes: list) -> list:
    """文頭の記号（Markdown の `**` `![` `*` など）を除いた実質的な先頭形態素列を返す。

    sudachi はこれらをいずれも「補助記号」として切り出すため、品詞で落とせる。
    """
    i = 0
    while i < len(morphemes) and morphemes[i].part_of_speech()[0] in TRAILING_SYMBOL_POS:
        i += 1
    return morphemes[i:]


def _strip_trailing_symbols(morphemes: list) -> list:
    """文末の記号（」など）を除いた実質的な最終形態素列を返す。"""
    i = len(morphemes)
    while i > 0 and morphemes[i - 1].part_of_speech()[0] in TRAILING_SYMBOL_POS:
        i -= 1
    return morphemes[:i]


def detect_nominal_ending_and_paragraph_conjunctions(
    lines: list[tuple[int, str]],
    tokenized: list[TokenizedSentence],
    raw_lines_by_no: dict[int, str] | None = None,
    nominal_min_sentences: int = NOMINAL_ENDING_MIN_SENTENCES,
    nominal_ratio_threshold: float = NOMINAL_ENDING_RATIO_THRESHOLD,
    nominal_min_chars: int = NOMINAL_ENDING_MIN_CHARS,
    conj_min_paragraphs: int = PARAGRAPH_CONJ_MIN_PARAGRAPHS,
    conj_ratio_threshold: float = PARAGRAPH_CONJ_RATIO_THRESHOLD,
    uniform_min_paragraphs: int = UNIFORM_PARAGRAPH_MIN_PARAGRAPHS,
    uniform_cv_threshold: float = UNIFORM_PARAGRAPH_CV_THRESHOLD,
) -> tuple[list[Finding], dict]:
    """sudachipy で形態素解析し、
    1) 体言止めの「欠如」（長文なのに体言止めが1つもない = 人間的修辞の欠如）
    2) 段落頭の接続詞率
    を計測する。stats も返す（JSON用）。

    体言止め検出はコーパス校正（2026-07）で方向を反転した。反転前は
    「体言止めが多い」ことを AI 臭として警告していたが、実コーパスでは
    体言止めは人間側の方が圧倒的に多く使う修辞技法（essay同ジャンルで
    人間60% vs AI 0%）だったため、前提が逆だった。現在は「ある程度の
    長さの文書なのに体言止めが1つもない」ことを、人間的な修辞技法の欠如
    （AIらしさの一側面）として info レベルで示す。
    """
    nominal_ending_count = 0
    total_sentences = 0
    total_chars = 0
    last_line = 1

    for ts in tokenized:
        total_sentences += 1
        total_chars += len(ts.raw_text)
        last_line = ts.line
        effective = _strip_trailing_symbols(ts.morphemes)
        if not effective:
            continue
        last = effective[-1]
        pos = last.part_of_speech()[0]
        # 体言止め: 実質的な最終形態素が名詞（助動詞「だ/です」等が続かない）場合
        if pos in NOUN_ENDING_POS:
            nominal_ending_count += 1

    ratio = nominal_ending_count / total_sentences if total_sentences else 0.0

    findings = []
    if (
        total_sentences >= nominal_min_sentences
        and total_chars >= nominal_min_chars
        and ratio <= nominal_ratio_threshold
    ):
        # 「欠如」の検出なので、体言止めの文自体は存在しない。指摘対象の1文を
        # 指させないため、文書末尾の行に1件だけ finding を出す（一覧性重視）。
        findings.append(
            Finding(
                line=last_line,
                category="nominal_ending",
                excerpt=f"体言止め0件（全{total_sentences}文、約{total_chars}字）",
                severity="info",
                detail=(
                    "この文書には体言止めが1つもない。ある程度の長さの文書で一度も使わないのは、"
                    "AI の書いた文章によく見られる特徴"
                ),
            )
        )

    # 段落頭の接続詞率
    # 段落を行番号付きでグルーピングすることで、段落開始行が直接分かる
    # （re.split + テキスト検索による line_cursor 近似だと、同一内容の段落が
    # 複数回登場したときに誤帰属していたため、行ベースの分割に置き換えた）。
    paragraphs = iter_paragraphs_with_lines(lines)
    conj_paragraph_count = 0
    total_paragraphs = len(paragraphs)
    conj_findings = []
    sentence_counts_per_paragraph = []
    for para_lines in paragraphs:
        first_no, first_line_raw = para_lines[0]
        first_line_text = first_line_raw.strip()
        para_joined = "\n".join(t for _, t in para_lines)
        sentence_counts_per_paragraph.append(
            len([p for p in SENTENCE_SPLIT_RE.split(para_joined) if p.strip()])
        )
        for conj in PARAGRAPH_CONJUNCTIONS:
            if first_line_text.startswith(conj):
                conj_paragraph_count += 1
                conj_findings.append((first_no, first_line_text, conj))
                break

    conj_ratio = conj_paragraph_count / total_paragraphs if total_paragraphs else 0.0
    if total_paragraphs >= conj_min_paragraphs and conj_ratio >= conj_ratio_threshold:
        conj_lines = [no for no, _, _ in conj_findings]
        related = format_related_lines(conj_lines)
        for no, text_line, conj in conj_findings:
            excerpt_source = _raw_or_masked(raw_lines_by_no, no, text_line)
            findings.append(
                Finding(
                    line=no,
                    category="paragraph_lead_conjunction",
                    excerpt=excerpt_source[:40],
                    severity="info",
                    detail=(
                        f"段落頭が接続詞「{conj}」で始まる（文書全体の段落頭接続詞率={conj_ratio:.1%}、"
                        f"閾値{conj_ratio_threshold:.0%}以上で警告）。{related}"
                    ),
                    related_lines=conj_lines,
                )
            )

    # 段落構造の均質性: AI は「3文段落」を量産しがち。段落あたり文数の変動係数が
    # 極端に低い（＝どの段落もほぼ同じ文数）場合は定型段落の疑いとして警告する。
    para_structure_stats = {
        "paragraph_sentence_counts": sentence_counts_per_paragraph,
        "paragraph_sentence_count_cv": None,
    }
    if len(sentence_counts_per_paragraph) >= uniform_min_paragraphs:
        p_mean = statistics.mean(sentence_counts_per_paragraph)
        p_std = statistics.pstdev(sentence_counts_per_paragraph)
        p_cv = (p_std / p_mean) if p_mean else 0.0
        para_structure_stats["paragraph_sentence_count_cv"] = p_cv
        if p_cv < uniform_cv_threshold:
            findings.append(
                Finding(
                    line=1,
                    category="uniform_paragraph_structure",
                    excerpt=f"段落数={len(sentence_counts_per_paragraph)}, 各段落の文数={sentence_counts_per_paragraph}",
                    severity="info",
                    detail=(
                        f"段落あたり文数の変動係数={p_cv:.3f}（閾値{uniform_cv_threshold}未満）。"
                        "どの段落もほぼ同じ文数=定型段落（例: 3文段落の量産）の疑い"
                    ),
                )
            )

    stats = {
        "total_sentences": total_sentences,
        "nominal_ending_count": nominal_ending_count,
        "nominal_ending_ratio": ratio,
        "total_paragraphs": total_paragraphs,
        "paragraph_lead_conjunction_count": conj_paragraph_count,
        "paragraph_lead_conjunction_ratio": conj_ratio,
        **para_structure_stats,
    }
    return findings, stats


def detect_translationese_morph(tokenized: list[TokenizedSentence]) -> list[Finding]:
    """品詞列で「こと（名詞）+ が/は（助詞）+ でき〜（動詞、"でき"始まりの活用形）」の並びを
    検出する、翻訳調「〜することができる」の品詞列版。
    表層の正規表現（TRANSLATIONESE_PATTERNS）と違い、直前の動詞部分の送り仮名や
    活用（〜することができる/〜出来ます/〜出来た 等）の表記揺れに影響されない。
    注意: 「こと」の前に本当に動詞（〜する）が来ているかまでは確認していない
    （「このことができる」のような非対象ケースを完全には除外できない）。
    """
    findings = []
    for ts in tokenized:
        surfaces = [m.surface() for m in ts.morphemes]
        poss = [m.part_of_speech()[0] for m in ts.morphemes]
        n = len(ts.morphemes)
        for i in range(n):
            # 「こと」(名詞) + が/は(助詞) + でき(動詞語幹)... の並びを探す
            if surfaces[i] == "こと" and poss[i] == "名詞":
                j = i + 1
                if j < n and poss[j] == "助詞" and surfaces[j] in {"が", "は"}:
                    k = j + 1
                    if k < n and poss[k] == "動詞" and surfaces[k].startswith("でき"):
                        # excerptは形態素のbegin/end（マスク済みテキスト内オフセット）を使い、
                        # 原文（raw_text）から同じ位置を切り出す（インラインコードスパンの
                        # バッククォート内文字列が欠落しないようにするため）。
                        span_start = ts.morphemes[max(0, i - 4)].begin()
                        span_end = ts.morphemes[k].end()
                        excerpt = ts.raw_text[span_start:span_end]
                        findings.append(
                            Finding(
                                line=ts.line,
                                category="translationese_morph",
                                excerpt=excerpt,
                                severity="info",
                                detail="「〜することができる」型の言い回し",
                            )
                        )
    return findings



# ふだん漢語で言う語を、和語の動詞の名詞化で書いたもの(「事実の確かめ」「知らせが来る」)。
# SKILL.md §3 の 5(語の組み合わせのずれ)のうち、辞書にはあるのでそのままでは拾えない型。
# sudachi はこれらを最初から名詞として切るので、語の表で持つ。動詞の連用形(「〜を確かめ、」)は
# 品詞が動詞になるので当たらない。「〜方」「〜直し」のような複合語も別の語になるので当たらない。
# 表に入れるのは、ふだんの文書で漢語のほうが通る語だけ。経理の「突き合わせ」のように分野で
# 定着している語は入れない(doctypes/guide.md の例に3回ある)。
WAGO_NOMINALIZATION = {
    "確かめ": "確認",
    "知らせ": "通知",
    "測り": "測定",
    "調べ": "調査",
}
# 「に」は「調べに行く」のような連用形+目的の形と区別がつかないので入れない
_WAGO_FOLLOWERS = {"の", "を", "は", "が", "も", "へ", "と", "で", "や", "か"}


def detect_wago_nominalization(tokenized: list[TokenizedSentence]) -> list[Finding]:
    """和語の動詞を名詞にした語(表 WAGO_NOMINALIZATION)が、名詞として助詞の前に置かれているものを拾う。"""
    findings = []
    for ts in tokenized:
        ms = ts.morphemes
        n = len(ms)
        for i, m in enumerate(ms):
            surf = m.surface()
            if surf not in WAGO_NOMINALIZATION or m.part_of_speech()[0] != "名詞":
                continue
            nxt = ms[i + 1] if i + 1 < n else None
            if nxt is not None and not (nxt.part_of_speech()[0] == "助詞" and nxt.surface() in _WAGO_FOLLOWERS):
                continue
            span_start = ms[max(0, i - 3)].begin()
            span_end = (nxt.end() if nxt is not None else m.end())
            findings.append(
                Finding(
                    line=ts.line,
                    category="wago_nominalization",
                    excerpt=ts.raw_text[span_start:span_end],
                    severity="warn",
                    detail=f"「{surf}」は、ふだん「{WAGO_NOMINALIZATION[surf]}」と書く",
                )
            )
    return findings


# 拗音を作る小書き文字（ャュョァィゥェォヮ）。「キャ」のように直前の文字と
# 合わせて1モーラを構成するため、単純な文字数カウントだと過大カウントになる。
# 促音（ッ）・長音（ー）は独立した1モーラとして数えるため、ここには含めない。
_SMALL_KANA_MERGE = set("ァィゥェォャュョヮ")


def mora_length(morphemes: list) -> int:
    """読み（カタカナ）を基にモーラ数の近似値を計算する。
    拗音の小書き文字（ャュョ等）は直前の文字と合算して1モーラとして数える
    補正を行うが、それ以外の長音・促音等の厳密な処理まではしていない。
    """
    total = 0
    for m in morphemes:
        reading = m.reading_form() or m.surface()
        count = 0
        for ch in reading:
            if ch in _SMALL_KANA_MERGE and count > 0:
                # 直前の文字と合わせて1モーラなので、追加でカウントしない
                continue
            count += 1
        total += count
    return total


def detect_rhythm_statistics(
    tokenized: list[TokenizedSentence],
    min_tokenized: int = BURSTINESS_MIN_TOKENIZED,
    burstiness_threshold: float = BURSTINESS_THRESHOLD,
    autocorr_min_xs: int = AUTOCORR_MIN_XS,
    autocorr_threshold: float = AUTOCORR_THRESHOLD,
) -> tuple[list[Finding], dict]:
    """文字数だけでなくモーラ近似長を使い、単純な変動係数に加えて
    burstiness（(σ-μ)/(σ+μ)）と隣接文長の自己相関（lag-1）を計測する。
    - burstiness が負に大きい ≈ 文長が均一（AI的）
    - 自己相関が高い ≈ 「短い文の後は短い文」というリズムパターンが固定化している
    """
    if len(tokenized) < min_tokenized:
        return [], {}

    mora_lengths = [mora_length(ts.morphemes) for ts in tokenized]
    mean = statistics.mean(mora_lengths)
    std = statistics.pstdev(mora_lengths)

    findings = []
    burstiness = (std - mean) / (std + mean) if (std + mean) else 0.0

    # lag-1 自己相関（ピアソン相関を1つずらした系列同士で計算）
    xs = mora_lengths[:-1]
    ys = mora_lengths[1:]
    autocorr = None
    if len(xs) >= autocorr_min_xs and statistics.pstdev(xs) > 0 and statistics.pstdev(ys) > 0:
        mx, my = statistics.mean(xs), statistics.mean(ys)
        cov = sum((a - mx) * (b - my) for a, b in zip(xs, ys)) / len(xs)
        autocorr = cov / (statistics.pstdev(xs) * statistics.pstdev(ys))

    # 閾値 -0.62: このスキルの原則は「自然な人間の文章で誤検知しない」こと。
    # 人間が書いた自然な文章（fixtures/natural.md 相当）でも burstiness は
    # -0.55 前後まで下がることが実測で分かっている（モーラ計算の拗音補正後の実測値）。
    # -0.55 ちょうどを閾値にすると、その実測値のごく僅かな変動で人間の文章にまで
    # 誤検知するため、マージンを取って -0.62 まで緩めている。
    if burstiness < burstiness_threshold:
        findings.append(
            Finding(
                line=tokenized[0].line,
                category="low_burstiness",
                excerpt=f"burstiness={burstiness:.3f} (モーラ近似長 平均={mean:.1f}, 標準偏差={std:.1f})",
                severity="warn",
                detail=f"文の長短の差が小さい（burstiness が閾値{burstiness_threshold}未満）。文の長さがそろいすぎている疑い",
            )
        )

    if autocorr is not None and autocorr > autocorr_threshold:
        findings.append(
            Finding(
                line=tokenized[0].line,
                category="high_length_autocorrelation",
                excerpt=f"lag-1 自己相関={autocorr:.3f}",
                severity="info",
                detail=f"隣接する文の長さが強く相関（閾値{autocorr_threshold}超）。文長パターンが単調に繰り返されている疑い",
            )
        )

    stats = {
        "mora_mean": mean,
        "mora_stdev": std,
        "burstiness": burstiness,
        "length_autocorrelation_lag1": autocorr,
    }
    return findings, stats



# 文頭反復の severity 判定: 固有名詞・製品名/技術用語（ラテン文字主体の表層）が
# 文頭に来る場合は「そして」「また」のような定型導入の使い回しとは性質が異なり、
# 技術文書では自然な反復（例: 「Cloudflareは」「better-authが」）なので
# severity を warn ではなく info に下げる（検出自体は残し、判断材料として提示する）。
_LATIN_TECH_TOKEN_RE = re.compile(r"^[A-Za-z][A-Za-z0-9\-_.]*$")


def _is_proper_noun_or_tech_term(morpheme) -> bool:
    """先頭形態素が固有名詞、またはラテン文字・数字主体（製品名/ライブラリ名等）かを判定する。
    カタカナ語は一般語（「クラウド」「システム」等）も多く誤って severity を下げるリスクが
    高いため、ここでは対象外とする（迷ったら対象外でよい、という方針）。
    """
    pos = morpheme.part_of_speech()
    surface = morpheme.surface()
    is_proper_noun = pos[0] == "名詞" and pos[1] == "固有名詞"
    is_latin_tech = bool(_LATIN_TECH_TOKEN_RE.match(surface))
    return is_proper_noun or is_latin_tech


def detect_ngram_repetition(
    tokenized: list[TokenizedSentence],
    lead_repeat_threshold: int = NGRAM_LEAD_REPEAT_THRESHOLD,
    template_min_count: int = NGRAM_TEMPLATE_MIN_COUNT,
    template_ratio_threshold: float = NGRAM_TEMPLATE_RATIO_THRESHOLD,
) -> tuple[list[Finding], dict]:
    """
    1) 文頭2形態素（表層形）の n-gram が3回以上繰り返される
       → 「そして、」「また、」のような定型導入の使い回し
       ただし先頭形態素が固有名詞・ラテン文字主体の技術用語（製品名/ライブラリ名等）の
       場合は技術文書として自然な反復なので severity を info に下げる（検出自体は残す）。
    2) 文頭のPOS 4-gram（品詞の粗い並び）の一致率が高い
       → 語彙は違っても構文テンプレートが同じ（AIにありがちな構造の使い回し）
    をそれぞれ検出する。
    """
    from collections import Counter

    findings = []

    lead_bigrams = []
    for ts in tokenized:
        # 文頭の補助記号を落としてから2形態素を取る。マスク処理は行単位の構造
        # （見出し・リスト・引用・表）とインラインコード/URLしか落とさないため、
        # インラインの強調記法（`**強調**`）や画像記法（`![alt](url)`）のマーカーが
        # 文頭に残る。これを数えると「文頭2形態素が **」という無意味な反復が量産される。
        # zenn-content 60本の実測で repeated_sentence_lead 236件のうち 100件（42%）が
        # この記号由来だった（`**` 88件 / `![` 12件）。
        lead_morphemes = _strip_leading_symbols(ts.morphemes)[:2]
        surfaces = [m.surface() for m in lead_morphemes]
        if len(surfaces) == 2:
            # 文頭が固有名詞・英字の技術用語・数(「2019年」「日本・」「Amazon」「Python」など)の
            # 反復は、記事の主題や日付を並べた自然な書き方で、人間の文書でも同じだけ出る
            # (2026-10 の測定で、人間の文書と生成AIの文書で件数に差がなかった)。数えない。
            first = lead_morphemes[0]
            if _is_proper_noun_or_tech_term(first) or first.part_of_speech()[1] == "数詞" or re.match(r"[0-9０-９]", first.surface()):
                continue
            lead_bigrams.append((ts.line, ts.raw_text, "".join(surfaces), False))

    bigram_counter = Counter(text for _, _, text, _ in lead_bigrams)
    for bigram, count in bigram_counter.items():
        if count >= lead_repeat_threshold:
            bigram_lines = [no for no, _, text, _ in lead_bigrams if text == bigram]
            related = format_related_lines(bigram_lines)
            # 同じ書き出しの反復は、反復ごとに1件にまとめる(出現ごとに数えると件数が膨らみ、
            # 指摘の大半を占めてしまう)。severity は常に info(人間の意図的な反復と区別できない)。
            no, sent, _, _ = next(x for x in lead_bigrams if x[2] == bigram)
            findings.append(
                Finding(
                    line=no,
                    category="repeated_sentence_lead",
                    excerpt=sent[:20],
                    severity="info",
                    detail=(
                        f"文頭2形態素「{bigram}」が{count}回反復（閾値{lead_repeat_threshold}回以上）。"
                        f"人間が意図して繰り返す場合と区別がつかないため、参考情報。{related}"
                    ),
                    related_lines=bigram_lines,
                )
            )

    lead_pos_ngrams = []
    for ts in tokenized:
        # 文頭2形態素と同じ理由で、ここでも文頭の補助記号を落としてから品詞列を取る
        # （落とさないと「補助記号/補助記号/名詞/助詞」が量産され一致率が跳ね上がる）。
        pos_seq = tuple(m.part_of_speech()[0] for m in _strip_leading_symbols(ts.morphemes)[:4])
        if len(pos_seq) == 4:
            lead_pos_ngrams.append((ts.line, ts.raw_text, pos_seq))

    total_with_ngram = len(lead_pos_ngrams)
    pos_counter = Counter(seq for _, _, seq in lead_pos_ngrams)
    stats = {"lead_pos_4gram_top": None, "lead_pos_4gram_ratio": None}
    if total_with_ngram >= template_min_count and pos_counter:
        top_seq, top_count = pos_counter.most_common(1)[0]
        ratio = top_count / total_with_ngram
        stats["lead_pos_4gram_top"] = "/".join(top_seq)
        stats["lead_pos_4gram_ratio"] = ratio
        if ratio >= template_ratio_threshold:
            template_lines = [no for no, _, seq in lead_pos_ngrams if seq == top_seq]
            related = format_related_lines(template_lines)
            for no, sent, seq in lead_pos_ngrams:
                if seq == top_seq:
                    findings.append(
                        Finding(
                            line=no,
                            category="repeated_syntax_template",
                            excerpt=sent[:20],
                            severity="info",
                            detail=(
                                f"文頭品詞4-gram「{'/'.join(top_seq)}」が全文の{ratio:.1%}で一致"
                                f"（閾値{template_ratio_threshold:.0%}以上）。構文テンプレートの使い回しの疑い。{related}"
                            ),
                            related_lines=template_lines,
                        )
                    )

    return findings, stats


def compute_mtld(tokens: list[str], threshold: float = 0.72) -> float | None:
    """MTLD（Measure of Textual Lexical Diversity）の簡易実装。
    文長に依存しにくい語彙多様性指標。TTR が threshold を下回るごとに
    「1ファクター」を数え、前方・後方2方向の平均をとる。
    """
    if len(tokens) < 20:
        return None

    def factors_one_direction(seq: list[str]) -> float:
        factor_count = 0
        types: set[str] = set()
        token_count = 0
        for tok in seq:
            types.add(tok)
            token_count += 1
            ttr = len(types) / token_count
            if ttr <= threshold:
                factor_count += 1
                types = set()
                token_count = 0
        # 端数分を部分ファクターとして加算
        if token_count > 0:
            types_ttr = len(types) / token_count if token_count else 1.0
            partial = (1 - types_ttr) / (1 - threshold) if types_ttr < 1 else 0.0
            factor_count += min(partial, 1.0)
        return len(seq) / factor_count if factor_count > 0 else float(len(seq))

    forward = factors_one_direction(tokens)
    backward = factors_one_direction(list(reversed(tokens)))
    return (forward + backward) / 2


def detect_lexical_diversity(
    tokenized: list[TokenizedSentence],
    min_tokens: int = LEXDIV_MIN_TOKENS,
    ttr_threshold: float = TTR_THRESHOLD,
    mtld_threshold: float = MTLD_THRESHOLD,
    min_doc_chars: int = LEXDIV_MIN_DOC_CHARS,
) -> tuple[list[Finding], dict]:
    """内容語（名詞/動詞/形容詞/副詞）の基本形を対象に TTR と MTLD を計測する。
    語彙が使い回されている（AIが同じ言い回しをループしがち）と TTR/MTLD が低くなる。

    2026-07 コーパス校正（corpus/reports/archive/length_analysis.md）: TTR は文書長
    ~4000字未満のビンではhuman/aiとも一律0%で、統計として機能していない
    ことが判明した。4000字以上のビンで初めて意味のある差（human 77%）が
    出るため、文書全体の文字数が min_doc_chars 未満の場合は「文書が短いため
    未評価」として明示的にスキップする（閾値ではなく適用条件でガードする、
    という報告書の推奨に沿った実装）。
    """
    content_tokens = []
    total_doc_chars = sum(len(ts.raw_text) for ts in tokenized)
    for ts in tokenized:
        for m in ts.morphemes:
            if m.part_of_speech()[0] in CONTENT_WORD_POS:
                content_tokens.append(m.dictionary_form())

    findings = []
    stats = {
        "ttr": None,
        "mtld": None,
        "content_token_count": len(content_tokens),
        "doc_char_count": total_doc_chars,
        "skipped_too_short": False,
    }
    if total_doc_chars < min_doc_chars:
        stats["skipped_too_short"] = True
        return findings, stats
    if len(content_tokens) >= min_tokens:
        ttr = len(set(content_tokens)) / len(content_tokens)
        mtld = compute_mtld(content_tokens)
        stats["ttr"] = ttr
        stats["mtld"] = mtld
        if ttr < ttr_threshold:
            findings.append(
                Finding(
                    line=tokenized[0].line,
                    category="low_lexical_diversity_ttr",
                    excerpt=f"TTR={ttr:.3f} (内容語 {len(content_tokens)} 語中 {len(set(content_tokens))} 種類)",
                    severity="info",
                    detail=f"TTR(Type-Token Ratio)が閾値{ttr_threshold}未満。同じ語彙の使い回しが多い疑い",
                )
            )
        if mtld is not None and mtld < mtld_threshold:
            findings.append(
                Finding(
                    line=tokenized[0].line,
                    category="low_lexical_diversity_mtld",
                    excerpt=f"MTLD={mtld:.1f}",
                    severity="info",
                    detail=f"MTLD が閾値{mtld_threshold}未満。文章長で正規化した語彙多様性が低い疑い",
                )
            )
    return findings, stats


_URL_IN_TEXT_RE = re.compile(r"https?://\S+")
_IDENTIFIER_RE = re.compile(r"(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_.\-]*[A-Za-z0-9](?![A-Za-z0-9_])")


def detect_low_specificity(
    lines: list[tuple[int, str]],
    raw_lines_by_no: dict[int, str] | None = None,
    min_chars: int = LOW_SPECIFICITY_MIN_CHARS,
    min_content_words: int = LOW_SPECIFICITY_MIN_CONTENT_WORDS,
    proper_noun_weight: float = LOW_SPECIFICITY_PROPER_NOUN_WEIGHT,
    numeric_weight: float = LOW_SPECIFICITY_NUMERIC_WEIGHT,
    example_marker_bonus: float = LOW_SPECIFICITY_EXAMPLE_MARKER_BONUS,
    abstract_noun_weight: float = LOW_SPECIFICITY_ABSTRACT_NOUN_WEIGHT,
    score_threshold: float = LOW_SPECIFICITY_SCORE_THRESHOLD,
) -> tuple[list[Finding], dict]:
    """段落単位で「具体性の欠如（一般論臭）」を検出する。

    固有名詞密度・数値/日付出現率・例示マーカーの有無を「具体性シグナル」として
    加点し、形式名詞・抽象名詞率を減点した合成スコアが閾値未満の段落を拾う。
    短い段落は誰が書いてもある程度抽象的になりうるため、文字数・内容語数の
    両方が最低ラインを超えた段落だけを判定対象にする（gate）。

    これは文体（言い回し）の問題ではなく、段落を支える固有名詞・数値・一次情報
    そのものが足りていない「素材不足」のサインであるため、detail では
    書き直しではなく情報収集を検討するよう促す
    （SKILL.md §1「素材」と §3 を参照）。
    """
    tokenizer = get_tokenizer()
    from sudachipy import SplitMode

    findings: list[Finding] = []
    paragraphs = iter_paragraphs_with_lines(lines)
    evaluated = 0
    fired = 0

    for para_lines in paragraphs:
        first_no, _ = para_lines[0]
        para_masked = "\n".join(t for _, t in para_lines)
        para_chars = len(para_masked)
        if para_chars < min_chars:
            continue

        # sudachipy は1回のtokenize呼び出しに約49KBのバイト数上限があるため、
        # 段落が長大な場合（青空文庫の長い段落等）に備えて行単位で分割して
        # トークナイズし、結果を連結する（行番号・オフセットは形態素解析後は
        # 使わないため連結して問題ない）。
        morphemes = []
        for _, para_line in para_lines:
            if not para_line.strip():
                continue
            morphemes.extend(tokenizer.tokenize(para_line, SplitMode.C))
        content_words = [m for m in morphemes if m.part_of_speech()[0] in CONTENT_WORD_POS]
        if len(content_words) < min_content_words:
            continue

        evaluated += 1

        proper_noun_count = sum(
            1 for m in content_words if m.part_of_speech()[0] == "名詞" and m.part_of_speech()[1] == "固有名詞"
        )
        # 英字の識別子(React、useState、`config.yaml` など)も、段落を具体的にする名前として数える。
        # インラインコードは解析用テキストでは空白にしてあるので、原文の行から数える。
        # sudachipy が英字の語を固有名詞と判定した分と二重に数えないよう、多いほうを採る。
        raw_para = "\n".join(_raw_or_masked(raw_lines_by_no, no, t) for no, t in para_lines)
        raw_para = _URL_IN_TEXT_RE.sub(" ", raw_para)
        identifier_count = len(_IDENTIFIER_RE.findall(raw_para))
        latin_proper = sum(
            1 for m in content_words
            if m.part_of_speech()[1] == "固有名詞" and re.fullmatch(r"[A-Za-z][\w.\-]*", m.surface())
        )
        proper_noun_count += max(0, identifier_count - latin_proper)
        abstract_noun_count = sum(
            1
            for m in content_words
            if m.part_of_speech()[0] == "名詞" and m.dictionary_form() in ABSTRACT_NOUN_WORDS
        )
        numeric_hit_count = len(list(NUMERIC_QUANTITY_RE.finditer(para_masked)))
        has_example_marker = any(marker in para_masked for marker in EXAMPLE_MARKER_WORDS)

        n_content = len(content_words)
        proper_noun_density = proper_noun_count / n_content
        numeric_density = numeric_hit_count / n_content
        abstract_noun_ratio = abstract_noun_count / n_content

        score = (
            proper_noun_density * proper_noun_weight
            + numeric_density * numeric_weight
            + (example_marker_bonus if has_example_marker else 0.0)
            - abstract_noun_ratio * abstract_noun_weight
        )

        if score < score_threshold:
            fired += 1
            excerpt_source = _raw_or_masked(raw_lines_by_no, first_no, para_lines[0][1])
            findings.append(
                Finding(
                    line=first_no,
                    category="low_specificity",
                    excerpt=excerpt_source.strip()[:40],
                    severity="info",
                    detail=(
                        f"段落の具体性スコア={score:.3f}（閾値{score_threshold}未満）。"
                        f"固有名詞密度={proper_noun_density:.3f}, 数値密度={numeric_density:.3f}, "
                        f"抽象名詞率={abstract_noun_ratio:.3f}, 例示マーカー={'あり' if has_example_marker else 'なし'}。"
                        "固有名詞・数値・実例が乏しく一般論に留まっている疑い。"
                        "素材が足りていないサイン"
                    ),
                )
            )

    stats = {
        "paragraphs_evaluated": evaluated,
        "paragraphs_fired": fired,
    }
    return findings, stats


# nested_attributive（連体修飾の入れ子検出）は 2026-07 コーパス校正で削除した。
# sweep_nested_attributive.md: 閾値1〜6のどの値でも人間FP率が5%を切らず
# （閾値3で人間85.4%が発火、AIも100%発火。閾値6まで緩めても人間51.2%が発火）、
# deep-analysis.md でも essay同ジャンルで人間100% vs AI 92〜100%とほぼ差がない
# 「全発火・弁別力なし」と判定された。閾値調整では救えないノイズだったため、
# 検出器そのものと専用ヘルパー（旧 build_line_to_paragraph_map）を削除している。
# 経緯は corpus/reports/archive/sweep_nested_attributive.md に記載。

# ---------------------------------------------------------------------------
# 英語統語の検出（挑戦枠）
# ---------------------------------------------------------------------------

# 無生物主語（＋こと/事実など形式名詞化）+ 他動詞的な述語、という
# 「英語を日本語に直訳した構文」のシグナルをまず正規表現で粗く拾う。
# sudachipy で主語の生物性判定を厳密にやるのは困難なため、
# 「これ/それ/この事実/〜こと/〜という事実」+ 「は/が」+ 文末近くの
# 他動詞（〜を〜する系）という表層パターンでヒューリスティックに検出する。
INANIMATE_SUBJECT_PATTERNS = [
    re.compile(r"(これ|それ|この事実|そのこと)(は|が).{0,40}(もたらす|示す|意味する|証明する|生み出す|反映する)"),
    re.compile(r".{0,20}(こと|事実)(は|が).{0,40}(もたらす|示す|意味する|証明する|生み出す|反映する)"),
]

# 「それは〜である。なぜなら〜だ」構文（隣接する2文にまたがるので
# 文リストを走査して検出する）
CLEFT_BECAUSE_HEAD = re.compile(r"^(それ|これ|この)は.{0,60}(である|だ)$")
BECAUSE_HEAD = re.compile(r"^(なぜなら|というのも)")


def detect_english_syntax_smell(
    lines: list[tuple[int, str]], raw_lines_by_no: dict[int, str] | None = None
) -> list[Finding]:
    findings = []
    for no, line in lines:
        raw_line = _raw_or_masked(raw_lines_by_no, no, line)
        for pat in INANIMATE_SUBJECT_PATTERNS:
            for m in re.finditer(pat, line):
                excerpt = raw_line[m.start() : m.end()] if len(raw_line) >= m.end() else m.group(0)
                findings.append(
                    Finding(
                        line=no,
                        category="english_syntax_inanimate_subject",
                        excerpt=excerpt,
                        severity="info",
                        detail="もの・ことを主語にして他動詞で受ける、英語の構文の直訳の疑い",
                    )
                )

    # マスク済みテキストで構文マッチしつつ、excerpt は原文の文（raw）から組み立てる
    sentences = split_sentences_with_lines(lines, raw_lines_by_no)
    for i in range(len(sentences) - 1):
        no1, s1, r1 = sentences[i]
        no2, s2, r2 = sentences[i + 1]
        if CLEFT_BECAUSE_HEAD.match(s1) and BECAUSE_HEAD.match(s2):
            findings.append(
                Finding(
                    line=no1,
                    category="english_syntax_cleft_because",
                    excerpt=f"{r1}。{r2}",
                    severity="warn",
                    detail="「それは〜である。なぜなら〜だ」型の強調構文（英語 It is ... because ... の直訳調）",
                )
            )
    return findings


def detect_inanimate_subject_morph(tokenized: list[TokenizedSentence]) -> list[Finding]:
    """品詞列ベースで「無生物主語(抽象代名詞/形式名詞) + が/は + 他動詞的述語」を検出する。
    厳密な生物性判定（有情/非情の意味論）は sudachipy の POS だけでは困難なため、
    「これ/それ/この事実」等の抽象指示語、または「〜こと/〜という事実」のような
    形式名詞化された主語に限定して、他動詞辞書（TRANSITIVE_SMELL_VERBS）とマッチする
    述語が同一文内に現れる場合のみ検出する。表層正規表現版より活用の揺れに強い。
    """
    findings = []
    for ts in tokenized:
        surfaces = [m.surface() for m in ts.morphemes]
        poss = [m.part_of_speech()[0] for m in ts.morphemes]
        dict_forms = [m.dictionary_form() for m in ts.morphemes]
        n = len(ts.morphemes)
        # 2形態素の指示表現（例:「この事実」）を「この」で先にマッチさせた場合、
        # 続く「事実」単体も形式名詞として再マッチしてしまい、同じ箇所が
        # 二重に検出されてしまう。skip_until でその形態素インデックスまでの
        # 単独マッチを抑制する。
        skip_until = -1
        for i in range(n):
            if i <= skip_until:
                continue
            # 単一形態素で成立する指示語・形式名詞
            is_abstract_subject = surfaces[i] in ABSTRACT_PRONOUNS or (
                poss[i] == "名詞" and surfaces[i] in {"こと", "事実", "の"}
            )
            subject_end = i
            if not is_abstract_subject:
                # 2形態素にまたがる指示表現（「この」+「事実」等）を、
                # 隣接する形態素を連結した表層文字列で判定する
                if i + 1 < n and (surfaces[i] + surfaces[i + 1]) in ABSTRACT_PRONOUN_PHRASES:
                    is_abstract_subject = True
                    subject_end = i + 1
            if not is_abstract_subject:
                continue
            skip_until = max(skip_until, subject_end)
            j = subject_end + 1
            if j >= n or poss[j] != "助詞" or surfaces[j] not in {"が", "は"}:
                continue
            # 主語マーカーの後、文末までの間に直訳調の他動詞があるか探す
            for k in range(j + 1, n):
                if poss[k] == "動詞" and dict_forms[k] in TRANSITIVE_SMELL_VERBS:
                    # excerptはbegin/end（マスク済みテキスト内オフセット）を使い、
                    # 原文（raw_text）から同じ位置を切り出す
                    span_start = ts.morphemes[max(0, i - 3)].begin()
                    span_end = ts.morphemes[k].end()
                    excerpt = ts.raw_text[span_start:span_end]
                    subject_text = "".join(surfaces[i : subject_end + 1])
                    findings.append(
                        Finding(
                            line=ts.line,
                            category="inanimate_subject_morph",
                            excerpt=excerpt,
                            severity="info",
                            detail=(
                                f"品詞列マッチ: 抽象主語「{subject_text}」+ {surfaces[j]} "
                                f"+ 他動詞的述語「{dict_forms[k]}」（英語統語の直訳調の疑い）"
                            ),
                        )
                    )
                    break
    return findings


# ---------------------------------------------------------------------------
# 構造層検出器（2026-07 コーパス校正で新設）
#
# ここまでの検出器はすべて Markdown 構造をマスクした「地の文」に対して働く。
# しかし deep-analysis.md §4c の5文書精読では、AI 生成文（特に claude-haiku-4-5
# のtech系）に「太字の多用」「番号付きフェーズ構造」「『まとめ』『おわりに』
# 定型見出しでの締め」といった、文章そのものではなく Markdown 構造レベルの
# 教科書的な癖が繰り返し観測された。この一群は逆にマスク前の raw テキストを
# 見る必要があるため、run_lint() 内で mask_markdown_structure() より前に
# 呼び出す専用の検出器ファミリーとして新設する。
#
# 注意: この一群はまだ deep-analysis.md の定量コーパス計測を経ておらず、
# 5文書の質的観察のみが根拠（暫定閾値）。EXPERIMENTAL_CATEGORIES に含めて
# デフォルト無効化し、--experimental フラグを付けたときだけ有効にする。
# ただし太字の多用(high_bold_density)だけは 2026-10 に測って既定で有効にした。
# 行頭の「**ラベル**:」を除いた文中の太字が1000字あたり3回以上(かつ3か所以上)になるのは、生成AI以前の Qiita 2022 で6%、
# LLM-jp 由来で0%、生成記事で6%、Qiita 2026 で22%。ラベルの太字は、作者の読み比べで残したほうが読みやすく探しやすかった。
# 作者の文書を推敲した版で、文中の太字が「ノイズで読みづらい」と言われた
# (corpus/reports/readability-ooda.md の11周目)。仕事の文書でも多すぎる太字は読みにくいので、
# business ジャンルでも無効にしない。
# ---------------------------------------------------------------------------
BOLD_SPAN_RE = re.compile(r"\*\*[^*\n]+\*\*")
# 行頭(箇条の頭を含む)の「**ラベル**:」は項目を探す目印なので数えない
BOLD_LABEL_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])?\s*\*\*[^*\n]+\*\*\s*[:：]", re.M)
BOLD_DENSITY_PER_1000_THRESHOLD = 3.0
BULLET_LINE_RATIO_THRESHOLD = 0.35
BULLET_LINE_MIN_LINES = 10
# 「まとめ」「おわりに」等の定型見出し（本文の中身ではなく予告的な構成の型を示す）
BOILERPLATE_HEADING_WORDS = {
    "まとめ",
    "おわりに",
    "終わりに",
    "さいごに",
    "最後に",
    "結論",
    "総括",
    "conclusion",
}
NUMBERED_PHASE_RE = re.compile(r"(フェーズ|ステップ|段階|ステージ)\s*[0-90-9１-９]")
NUMBERED_PHASE_MIN_COUNT = 3
# 絵文字・装飾記号（代表的なものに限定。厳密な Unicode 絵文字判定は行わない）
EMOJI_SYMBOL_RE = re.compile(
    "[\U0001F300-\U0001FAFF☀-➿⭐✅❌❗❓]"
)
EMOJI_SYMBOL_PER_1000_THRESHOLD = 2.0


def detect_structural_ai_habits(raw_text: str) -> tuple[list[Finding], dict]:
    """マスク前の raw テキストに対して、Markdown 構造レベルの「教科書的AI癖」を検出する。
    太字密度・箇条書き行比率・定型見出し・番号付きフェーズ構造・絵文字/装飾記号密度の
    5種類。すべて severity="info"、EXPERIMENTAL カテゴリ扱い（デフォルト無効）。
    """
    findings: list[Finding] = []
    raw_lines = iter_lines_with_no(raw_text)
    total_chars = len(raw_text) or 1

    # 1) 太字密度
    label_starts = {m.end() - len(m.group(0).lstrip()) for m in BOLD_LABEL_RE.finditer(raw_text)}
    bold_hits = [m for m in BOLD_SPAN_RE.finditer(raw_text)
                 if not any(st <= m.start() <= st + 4 for st in label_starts)]
    bold_per_1000 = len(bold_hits) / total_chars * 1000
    if bold_per_1000 >= BOLD_DENSITY_PER_1000_THRESHOLD and len(bold_hits) >= 3:
        first_line = raw_text[: bold_hits[0].start()].count("\n") + 1
        findings.append(
            Finding(
                line=first_line,
                category="high_bold_density",
                excerpt=f"文中の太字{len(bold_hits)}箇所（1000字あたり{bold_per_1000:.2f}）",
                severity="info",
                detail=(
                    f"文中の強調の太字（**...**）が閾値（1000字あたり{BOLD_DENSITY_PER_1000_THRESHOLD}）"
                    "以上。行頭の「**ラベル**:」は数えていない"
                ),
            )
        )

    # 2) 箇条書き行比率
    non_blank_lines = [(no, line) for no, line in raw_lines if line.strip()]
    bullet_lines = [no for no, line in non_blank_lines if _LIST_ITEM_RE.match(line)]
    if len(non_blank_lines) >= BULLET_LINE_MIN_LINES:
        bullet_ratio = len(bullet_lines) / len(non_blank_lines)
        if bullet_ratio >= BULLET_LINE_RATIO_THRESHOLD:
            findings.append(
                Finding(
                    line=bullet_lines[0] if bullet_lines else 1,
                    category="high_bullet_ratio",
                    excerpt=f"箇条書き行{len(bullet_lines)}/{len(non_blank_lines)}行（{bullet_ratio:.1%}）",
                    severity="info",
                    detail=(
                        f"箇条書き行の比率が閾値{BULLET_LINE_RATIO_THRESHOLD:.0%}以上。"
                        "文章より箇条書きに頼る構成は教科書的なAI生成文に見られる傾向（実験的検出器）"
                    ),
                    related_lines=bullet_lines if len(bullet_lines) > 1 else None,
                )
            )

    # 3) 定型見出し（「まとめ」「おわりに」等）
    boilerplate_lines = []
    for no, line in iter_lines_with_no(raw_text):
        m = _HEADING_RE.match(line)
        if not m:
            continue
        heading_text = line[m.end() :].strip().lower()
        for word in BOILERPLATE_HEADING_WORDS:
            if heading_text.startswith(word.lower()):
                boilerplate_lines.append((no, line.strip(), word))
                break
    for no, line_text, word in boilerplate_lines:
        findings.append(
            Finding(
                line=no,
                category="boilerplate_heading",
                excerpt=line_text[:40],
                severity="info",
                detail=(
                    f"定型見出し「{word}」系での締め。予告・構成の型のみで中身を語らない"
                    "教科書的なAI生成文に見られる傾向（実験的検出器）"
                ),
            )
        )

    # 4) 番号付きフェーズ構造（「フェーズ1」「ステップ2」等が3回以上）
    phase_hits = list(NUMBERED_PHASE_RE.finditer(raw_text))
    if len(phase_hits) >= NUMBERED_PHASE_MIN_COUNT:
        first_line = raw_text[: phase_hits[0].start()].count("\n") + 1
        findings.append(
            Finding(
                line=first_line,
                category="numbered_phase_structure",
                excerpt=f"番号付きフェーズ表現が{len(phase_hits)}回出現",
                severity="info",
                detail=(
                    f"「フェーズ/ステップ/段階+番号」の表現が閾値{NUMBERED_PHASE_MIN_COUNT}回以上。"
                    "機械的な段階分割は教科書的なAI生成文に見られる傾向（実験的検出器）"
                ),
            )
        )

    # 5) 絵文字・装飾記号の密度
    emoji_hits = list(EMOJI_SYMBOL_RE.finditer(raw_text))
    emoji_per_1000 = len(emoji_hits) / total_chars * 1000
    if emoji_per_1000 >= EMOJI_SYMBOL_PER_1000_THRESHOLD and len(emoji_hits) >= 3:
        first_line = raw_text[: emoji_hits[0].start()].count("\n") + 1
        findings.append(
            Finding(
                line=first_line,
                category="high_emoji_symbol_density",
                excerpt=f"絵文字/装飾記号{len(emoji_hits)}箇所（1000字あたり{emoji_per_1000:.2f}）",
                severity="info",
                detail=(
                    f"絵文字・装飾記号の使用密度が閾値（1000字あたり{EMOJI_SYMBOL_PER_1000_THRESHOLD}）"
                    "以上（実験的検出器、閾値は暫定）"
                ),
            )
        )

    stats = {
        "bold_span_count": len(bold_hits),
        "bold_per_1000_chars": bold_per_1000,
        "bullet_line_count": len(bullet_lines),
        "non_blank_line_count": len(non_blank_lines),
        "boilerplate_heading_count": len(boilerplate_lines),
        "numbered_phase_hit_count": len(phase_hits),
        "emoji_symbol_count": len(emoji_hits),
        "emoji_symbol_per_1000_chars": emoji_per_1000,
    }
    return findings, stats


# ---------------------------------------------------------------------------
# 読みにくそうな箇所の検査（推敲で見る箇所を示すだけ）
#
# ここに並ぶ検出器は「AI臭さ」を測らない。自然度スコアにも、by_category 集計にも、
# --baseline 比較にも一切入らない。目的は「読みやすい文章に直す」ことだけで、
# 出力は「この文を見る」と示すだけにする（severity は常に info）。
#
# なぜ別レーンなのか:
#     corpus/reports/readability-sweep.md は、ここに実装した指標のほとんど
#     （文長・読点密度・二重否定・漢字比率）を候補として検証し、すべて NO-GO と
#     判定している。ただしその判定基準は「AI か人間かを弁別できるか」「下手な人間の
#     文章を当てられるか」であり、分類器としての採否基準だった。文長の AI 検出率が
#     1.0% だったのは「長い文は AI の証拠にならない」という意味であって、
#     「長い文は読みやすい」という意味ではない。レポート自身が結論している
#     とおり、検証した14候補は「『AIらしさ』の代理指標であり『文章の読みにくさ』の
#     直接的な代理指標にはなっていない」。
#
#     したがってこのレーンの採否基準は弁別力ではなく、「指摘に従って直した文が、
#     原文より読みやすくなるか」に置く。その基準での校正が済むまでは opt-in
#     （--reading-load）に留め、既存の findings / stats / baseline には混ぜない。
#     混ぜた瞬間に「AI臭さの採点」と「読みやすさの推敲」という別目的の指標が
#     同じスコアに合算され、どちらの判断にも使いにくくなる。
#
# このレーンが存在する理由（検出器を足すかどうかの判断基準）:
#     lint.py 本体が機械検出を要求するのは「AI は自分の AI 臭さを認識できない」からである。
#     しかし読解負荷は AI に見える。142字の文は、読めば長いと分かる。
#     ではなぜ検出器が要るのか——**網羅性**のためである。15,000字の文書を読む AI は、
#     11本ある長文のうち何本かには気づくが、全部には気づかない。機械なら全部を決定的に拾う。
#
#     したがって、このレーンに検出器を足してよいのは「AI が読み流すと見落とすもの」だけ。
#     読めば確実に気づくものに検出器を足しても、指摘が増えるだけで判断は良くならない。
#     この基準により、接続助詞「が」の連鎖を指す doubled_conjunctive_ga は削除した
#     （AI生成9,889文で1件・人間執筆379文で0件。見落とし以前に、そもそも起きていない）。
#
# 各検出器の直し方は SKILL.md §5「読みやすさの点検」と HINTS に書いてある。
# 閾値は当面 textlint-rule-preset-ja-technical-writing の既定値に合わせた暫定値で、
# 上記の基準で校正して調整する。
# ---------------------------------------------------------------------------

READING_LOAD_SENTENCE_MAX_CHARS = 90  # B1: これを超える文を指さす
# F1: 読点区切りの名詞句がこの個数以上連続し、かつ文がこの長さ以上なら埋もれた列挙とみなす。
# 当初は「読点が4個以上（B4）」で実装したが、artifactshare コーパス241本の校正で
# 62% の文書が発火し、しかも中身はほぼ全部が同格の列挙だった（「一覧、件数、絞り込み、
# アクセス判定では〜」など）。読点の打ち方の問題ではなく列挙の構造化の問題なので、
# カタログ B4 ではなく F1 を指す検出器に置き換えた。
READING_LOAD_BURIED_LIST_MIN_ITEMS = 3
READING_LOAD_BURIED_LIST_MIN_CHARS = 50
# 同じ校正で、項目3個の指摘は精度が落ちた（括弧の中だけの列挙や、並列の条件節を
# 列挙と誤認する例が混ざる。4個以上はほぼ全件が真の列挙だった）。3個のときだけ
# 対象をより長い文に絞る。短い3項目は箇条書きにするまでもないことが多い。
READING_LOAD_BURIED_LIST_3ITEM_MIN_CHARS = 80
READING_LOAD_KANJI_RUN_MAX = 6  # C1: 連続漢字がこれを超える（7字以上）
READING_LOAD_NO_CHAIN_MIN = 3  # C2: 格助詞「の」がこの回数以上連鎖する
# A1/A2: 2つの否定形態素がこの距離以内に並ぶと二重否定の候補とみなす。
# 「招かないとは言えません」（招か/ない/と/は/言え/ませ/ん = 距離5）まで拾える値。
READING_LOAD_NEGATION_MAX_GAP = 6

READING_LOAD_CATEGORIES: set[str] = {
    "sentence_too_long",
    "buried_list",
    "kanji_run",
    "double_negative",
    "no_chain",
    "sentence_in_paren",
}

_KANJI_RUN_RE = re.compile(rf"[一-鿿々]{{{READING_LOAD_KANJI_RUN_MAX + 1},}}")

# 否定を表す形態素。sudachi は形容詞の「ない」を「無い」に、助動詞の「ん」（「言えません」の
# 「ん」）を「ず」に正規化するため、表層ではなく正規化形で判定する。
# 「ぬ」（「知らぬ」）も同系統だが正規化形は「ぬ」のまま出るので両方持つ。
_NEGATION_NORMALIZED = {"ない", "無い", "ぬ", "ず"}
_NEGATION_POS = {"助動詞", "形容詞"}


_WHITESPACE_RUN_RE = re.compile(r"\s{2,}")


def _reading_length(text: str) -> int:
    """読み手が実際に読む文字数の近似を返す。

    mask_markdown_structure() は Markdown リンクの URL 部分とインラインコード
    スパンを「同じ文字数の空白」に置換して行内オフセットを保つ。その空白は
    読み手の目には映らないので、素の len() で数えると URL の長い文ほど不当に
    長く見積もられる（実測 50字ほどの文が 90字超と判定された）。
    2文字以上続く空白を1文字に畳んでから数えることで、URL・コードスパンの
    見かけの長さを取り除く。英単語のあいだの単独スペースは読む対象なので残す。
    """
    return len(_WHITESPACE_RUN_RE.sub(" ", text).strip())


def _span_contains_proper_noun(morphemes: list, start: int, end: int) -> bool:
    """文字オフセット [start, end) に重なる形態素に固有名詞が含まれるか。

    sudachi の Morpheme.begin()/end() は解析対象文字列上のオフセットを返すので、
    同じ文字列に対する正規表現マッチの位置とそのまま突き合わせられる。
    """
    for m in morphemes:
        if m.end() > start and m.begin() < end and m.part_of_speech()[1] == "固有名詞":
            return True
    return False


def _is_negation(morpheme) -> bool:
    return (
        morpheme.part_of_speech()[0] in _NEGATION_POS
        and morpheme.normalized_form() in _NEGATION_NORMALIZED
    )


# 形の上では否定が二重に掛かるが、義務・必然を表す語彙化した定型で、読み手が
# 符号の反転を計算することはない表現。実測（音楽レーベル記事の「同じ顔を保たないと
# いけません」）で誤検知したため除外する。二重否定の litotes（「ないわけではない」
# 「ないとは言えない」）はこれらの部分文字列を含まないので取りこぼさない。
_OBLIGATION_SPANS = (
    "といけ",
    "とだめ",
    "とダメ",
    "ばならな",
    "ばなりま",
    "ばいけな",
    "てはならな",
    "てはなりま",
    "てはいけな",
    "ざるを得",
    "ざるをえ",
)


def _is_obligation_form(span: str) -> bool:
    return any(s in span for s in _OBLIGATION_SPANS)


# 「〜ないと動かない」「〜なければ意味がない」のような、条件節の否定と帰結の否定が
# 並ぶ形。形の上では否定が2つあるが、日本語で必要条件を述べる標準的な言い方であり、
# 読み手が符号の反転を計算することはない。artifactshare コーパス241本の校正で、
# double_negative の誤検知のうち最大の塊がこの形だった。
# 「〜ないとは言えない」（真の litotes）は「と」の直後に「は」が来るので除外しない。
_CONDITIONAL_NEGATION_RE = re.compile(r"^(?:ない|なけれ|なく)(?:と(?!は)|ば|ければ)")


def _is_conditional_negation(span: str) -> bool:
    return bool(_CONDITIONAL_NEGATION_RE.match(span))


_OPEN_PARENS = ("（", "(", "「", "『", "【", "［", "[")
_CLOSE_PARENS = ("）", ")", "」", "』", "】", "］", "]")


def _segment_ends_with_noun(segment: list) -> bool:
    """読点で区切られた1区画が名詞で終わる（＝述語を持たない名詞句）かを判定する。

    末尾の補助記号を落とすだけでは「確認ポイント（どのアプリが前面に出るか）」のような
    括弧付きの項目を取りこぼすため、末尾の括弧グループごと遡ってから品詞を見る。
    """
    i = len(segment)
    while i > 0:
        m = segment[i - 1]
        if m.part_of_speech()[0] not in TRAILING_SYMBOL_POS:
            break
        if m.surface() in _CLOSE_PARENS:
            depth = 1
            j = i - 1
            while j > 0 and depth:
                j -= 1
                s = segment[j].surface()
                if s in _CLOSE_PARENS:
                    depth += 1
                elif s in _OPEN_PARENS:
                    depth -= 1
            i = j
        else:
            i -= 1
    return i > 0 and segment[i - 1].part_of_speech()[0] == "名詞"


def _longest_noun_phrase_run(morphemes: list) -> tuple[int, int, int] | None:
    """読点区切りの区画のうち、名詞で終わる区画が連続する最長の並びを返す。

    戻り値は (開始形態素index, 終了形態素index, 区画数)。
    READING_LOAD_BURIED_LIST_MIN_ITEMS 個に満たなければ None。
    """
    bounds: list[tuple[int, int]] = []
    start = 0
    for i, m in enumerate(morphemes):
        if m.surface() == "、":
            bounds.append((start, i))
            start = i + 1
    bounds.append((start, len(morphemes)))

    # 列挙の最後の項目は述語に溶けるのが普通なので（「A、B、C を行います」の C）、
    # 裸の名詞句で終わる区画は項目数より1つ少なく数えられる。連続する名詞句区画が
    # (MIN_ITEMS - 1) 個あり、そのあとに区画が続いていれば、その続きを最後の項目
    # とみなして列挙と判定する。
    need = READING_LOAD_BURIED_LIST_MIN_ITEMS - 1
    best: tuple[int, int, int] | None = None
    run: list[tuple[int, int]] = []
    for idx, (s, e) in enumerate(bounds):
        if e > s and _segment_ends_with_noun(morphemes[s:e]):
            run.append((s, e))
        else:
            run = []
        has_tail = idx + 1 < len(bounds)
        if len(run) >= need and has_tail:
            items = len(run) + 1
            if best is None or items > best[2]:
                best = (run[0][0], bounds[idx + 1][1], items)
    return best


def _has_punctuation_between(morphemes: list, i: int, j: int) -> bool:
    """morphemes[i] と morphemes[j] のあいだに読点などの補助記号があるか。

    「行かないし、来ない」のように、読点をまたいで別々の節がそれぞれ否定されている
    ケースを二重否定（「〜ないわけではない」）と誤認しないためのガード。
    """
    return any(m.part_of_speech()[0] == "補助記号" for m in morphemes[i + 1 : j])


def detect_reading_load(
    tokenized: list[TokenizedSentence],
    sentence_max_chars: int = READING_LOAD_SENTENCE_MAX_CHARS,
) -> list[Finding]:
    """読解負荷の高い箇所を指さす（判定もスコアも出さない）。

    直し方は SKILL.md §5「読みやすさの点検」と HINTS。
    """
    findings: list[Finding] = []
    for ts in tokenized:
        text = ts.text
        excerpt = (ts.raw_text or text).strip()[:40]

        # --- B1: 一文が長すぎる ---
        reading_len = _reading_length(text)
        if reading_len > sentence_max_chars:
            findings.append(
                Finding(
                    line=ts.line,
                    category="sentence_too_long",
                    excerpt=excerpt,
                    severity="info",
                    detail=(
                        f"一文が{reading_len}字（目安{sentence_max_chars}字）。"
                        "一文に主張が二つ以上入っていないかを確かめる"
                    ),
                )
            )


        # --- C1: 連続漢字 ---
        for m in _KANJI_RUN_RE.finditer(text):
            # 固有名詞を含む連なりは除外する（「東京地方裁判所」「特定商取引法表示」など）。
            # 分解できない名前であって、書き手が直せる読みにくさではない。
            # 241本の校正では、拾いたい側（「初回課金転換率」「視覚回帰受領証」のような
            # AI が作る圧縮漢語）はいずれも普通名詞だけで構成されていた。
            if _span_contains_proper_noun(ts.morphemes, m.start(), m.end()):
                continue
            findings.append(
                Finding(
                    line=ts.line,
                    category="kanji_run",
                    excerpt=m.group(0),
                    severity="info",
                    detail=(
                        f"漢字が{len(m.group(0))}字連続（目安{READING_LOAD_KANJI_RUN_MAX}字）。"
                        "語の切れ目が読み取りにくい疑い"
                    ),
                )
            )

        morphemes = ts.morphemes

        # --- F1: 埋もれた列挙 ---
        run = _longest_noun_phrase_run(morphemes)
        if run is not None:
            start, end, items = run
            min_chars = (
                READING_LOAD_BURIED_LIST_3ITEM_MIN_CHARS
                if items <= 3
                else READING_LOAD_BURIED_LIST_MIN_CHARS
            )
        if run is not None and reading_len >= min_chars:
            findings.append(
                Finding(
                    line=ts.line,
                    category="buried_list",
                    excerpt="".join(m.surface() for m in morphemes[start:end])[:40],
                    severity="info",
                    detail=(
                        f"同格の名詞句が読点で{items}個並んでいる（一文{reading_len}字）。"
                        "並んだ項目を読み手が頭の中で組み立て直すことになる"
                    ),
                )
            )

        # --- A1/A2: 二重否定・否定の入れ子 ---
        negation_idx = [i for i, m in enumerate(morphemes) if _is_negation(m)]
        for a, b in zip(negation_idx, negation_idx[1:]):
            span = "".join(m.surface() for m in morphemes[a : b + 1])
            if (
                b - a <= READING_LOAD_NEGATION_MAX_GAP
                and not _has_punctuation_between(morphemes, a, b)
                and not _is_obligation_form(span)
                and not _is_conditional_negation(span)
            ):
                findings.append(
                    Finding(
                        line=ts.line,
                        category="double_negative",
                        excerpt=span,
                        severity="info",
                        detail=(
                            "否定が二重に掛かっている疑い"
                        ),
                    )
                )
                break

        # --- C2: 「の」の連鎖 ---
        no_idx = [
            i
            for i, m in enumerate(morphemes)
            if m.surface() == "の" and m.part_of_speech()[:2] == ("助詞", "格助詞")
        ]
        for k in range(len(no_idx) - READING_LOAD_NO_CHAIN_MIN + 1):
            window = no_idx[k : k + READING_LOAD_NO_CHAIN_MIN]
            gaps_ok = all(y - x <= 3 for x, y in zip(window, window[1:]))
            if gaps_ok and not _has_punctuation_between(morphemes, window[0], window[-1]):
                findings.append(
                    Finding(
                        line=ts.line,
                        category="no_chain",
                        excerpt="".join(m.surface() for m in morphemes[window[0] : window[-1] + 1]),
                        severity="info",
                        detail=(
                            f"格助詞「の」が{READING_LOAD_NO_CHAIN_MIN}つ以上続いている。係り受けが分かりにくい疑い"
                        ),
                    )
                )
                break

    findings.sort(key=lambda f: f.line)
    attach_hints(findings)
    return findings


# 括弧の中に文が入っているか。括弧の中の「」『』は引用なので先に外し、残りに句点が
# あるかを見る。末尾の句点だけ(「(〜です。)」)も文として扱う。
# 2026-10 の実測(人の文章 245 本、Opus 5.5 の仕事の文書 40 本)では、人の文章でも1割前後の
# 文書に1件は出る(余談の括弧、エッセイ)。文書単位の多用の判定に使うほどの差はないので、
# AI らしさのレーンには入れず、ここで1件ずつ見る箇所として示す。
_PAREN_RE = re.compile(r"[（(]([^（()）\n]{2,200})[)）]")
_PAREN_QUOTE_RE = re.compile(r"「[^「」]*」|『[^『』]*』")
_JA_CHAR_RE = re.compile(r"[ぁ-んァ-ヶ一-鿿]")


def detect_sentence_in_paren(raw_text: str) -> list[Finding]:
    """括弧の中に文が入っている箇所を指さす。

    文分割は句点で切るので括弧の中の文を割ってしまう。そのため文単位ではなく行単位で見る。
    箇条書きの項目は対象に含め、コードブロック・表・引用・インラインコードは除く。
    """
    findings: list[Finding] = []
    in_fence = False
    for no, line in iter_lines_with_no(mask_html_comments(raw_text)):
        if _CODE_FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        stripped = line.lstrip()
        if in_fence or stripped.startswith(("|", ">")) or line.startswith("    "):
            continue
        for m in _PAREN_RE.finditer(_blank_inline_code_spans(line)):
            inner = _PAREN_QUOTE_RE.sub("", m.group(1))
            if "。" not in inner or not _JA_CHAR_RE.search(inner):
                continue
            findings.append(
                Finding(
                    line=no,
                    category="sentence_in_paren",
                    excerpt=line[m.start() : m.end()][:60],
                    severity="info",
                    detail="括弧の中に文が入っている。括弧の中は読み飛ばされやすい",
                )
            )
    return findings


def run_reading_load(raw_text: str, genre: str | None = None) -> tuple[list[Finding], dict]:
    """読みにくそうな箇所の検査だけを実行する。

    run_lint() とは意図的に独立した関数にしてある。既存の findings / stats /
    baseline 比較に読解負荷の finding が混入する経路を、構造として作らないため。
    マスク・文分割・形態素解析の手順は run_lint() と同じで、Tokenizer は
    textcore.get_tokenizer() のシングルトンを共有する。
    """
    profile = GENRE_PROFILES.get(genre, {})
    text = mask_markdown_structure(raw_text)
    lines = iter_lines_with_no(text)
    raw_lines_by_no = dict(iter_lines_with_no(raw_text))
    sentences = split_sentences_with_lines(lines, raw_lines_by_no)
    tokenized = tokenize_sentences(sentences)

    findings = detect_reading_load(
        tokenized,
        sentence_max_chars=profile.get(
            "reading_load_sentence_max_chars", READING_LOAD_SENTENCE_MAX_CHARS
        ),
    )
    # 「〜ことができる」は生成AIらしさではなく冗長さの指摘として、このレーンで出す。
    findings += detect_translationese_morph(tokenized)
    findings += detect_sentence_in_paren(raw_text)
    findings.sort(key=lambda f: f.line)
    attach_hints(findings)
    stats = {
        "total": len(findings),
        "sentences": len(tokenized),
        "genre": genre,
        "by_category": {},
    }
    for f in findings:
        stats["by_category"][f.category] = stats["by_category"].get(f.category, 0) + 1
    return findings, stats


# ---------------------------------------------------------------------------
# メイン処理
# ---------------------------------------------------------------------------

# 2026-07 コーパス校正で「無反応」（human/aiともにほぼ0%発火）と判定された
# 検出器（corpus/reports/archive/deep-analysis.md §3, §5）。sweepで閾値を緩めても
# low_burstiness 以外は弁別力を示す根拠データがまだない（sweepレポート未生成）ため、
# 削除はせず「実験的（experimental）」としてデフォルト無効化する。
# 加えて、新設の構造層検出器（high_bold_density 等）もまだ定量校正前なので
# 同様に実験的カテゴリに含める。
# --experimental フラグを付けたときだけ、これらのカテゴリの finding を残す。
EXPERIMENTAL_CATEGORIES: set[str] = {
    "high_length_autocorrelation",
    "paragraph_lead_conjunction",
    "repeated_syntax_template",
    "english_syntax_cleft_because",
    "high_bullet_ratio",
    "boilerplate_heading",
    "numbered_phase_structure",
    "high_emoji_symbol_density",
}


# ---------------------------------------------------------------------------
# 指摘ごとの直し方。SKILL.md §4 は「各指摘の説明に、何を疑っているかと直し方が書いてある」
# と前提にしているので、カテゴリを足したらここにも足す。直し方は短く、何をすればよいかを書く。
# ---------------------------------------------------------------------------
HINTS = {
    "forbidden_phrase": "多くは削っても意味が変わらない。削ると前後がつながらないときだけ、元の文書の内容で言い換える。固有名詞や引用の一部なら残す",
    "translationese": "日本語でふつうに言う形にする（「〜という点で」→「〜では」、「〜を持つ」→「〜がある」）",
    "translationese_morph": "「〜することができる」は「〜できる」か、動詞の可能形にする",
    "wago_nominalization": "ふだん漢語で言う語を、和語の動詞の名詞化で書いたもの。直し方に挙げた漢語にする(「事実の確かめ」→「事実の確認」)。動詞のまま(「〜を確かめる」)なら自然なので、文を動詞の形に戻してもよい",
    "antithesis_repetition": "読み手の誤解を正している対比だけを残し、ほかは肯定文に直す。対比の後半だけで意味が通らないものは言い換えにすぎない",
    "negation_repetition": "事実や注意としての打ち消し(「必須ではありません」「預金保険の対象ではありません」)は残す。誰も言っていない思い込みを先回りして打ち消す文(「〜するだけで自動的に〜わけではない」)は、文ごと削り、次の文の中身を残す。「AはBではない。Cだ。」は、打ち消しを削り、主語を肯定の文につなぐ(「AはCだ。」)。新しい言葉は足さない",
    "low_sentence_variance": "新しく書くときは、内容のまとまりに合わせて文を分けたりつないだりする。既存の文書を直すときは、これだけを理由に文を変えない。リズムのためだけに短い文を差し込まない",
    "low_burstiness": "新しく書くときは、内容のまとまりに合わせて文を分けたりつないだりする。既存の文書を直すときは、これだけを理由に文を変えない。リズムのためだけに短い文を差し込まない",
    "high_length_autocorrelation": "新しく書くときは、内容のまとまりに合わせて文を分けたりつないだりする。既存の文書を直すときは、これだけを理由に文を変えない。リズムのためだけに短い文を差し込まない",
    "nominal_ending": "参考情報。体言止めを無理に足さなくてよい。ほかの指摘と合わせて判断する",
    "paragraph_lead_conjunction": "前の段落と内容でつながるなら接続詞を外す。論理の関係を示すのに必要なら残す",
    "uniform_paragraph_structure": "段落の長さを内容の重さに合わせる。重要な段落は長く、軽い段落は短くてよい",
    "repeated_sentence_lead": "参考情報。同じ書き出しが続くところは、文の順序や主語を入れ替えるか、2文を1文にまとめる",
    "repeated_syntax_template": "同じ組み立ての文が続くところは、文の順序や主語を入れ替えるか、2文を1文にまとめる",
    "low_lexical_diversity_ttr": "参考情報。語を言い換えて散らすのではなく、抽象的な語を具体的な語にできないかを見る。用語は同じ語にそろえたままでよい",
    "low_lexical_diversity_mtld": "参考情報。語を言い換えて散らすのではなく、抽象的な語を具体的な語にできないかを見る。用語は同じ語にそろえたままでよい",
    "low_specificity": "新しく書くときは素材を集め直す。既存の文書を直すときは、自分で具体例や数値を足さず、どんな素材があれば具体的にできるかをユーザーに伝える",
    "english_syntax_inanimate_subject": "人や状況を主語にするか、「〜から分かる」「〜を見ると」のように言い換える",
    "inanimate_subject_morph": "人や状況を主語にするか、「〜から分かる」「〜を見ると」のように言い換える",
    "english_syntax_cleft_because": "理由を先に書くか、「〜だからだ」で一文にまとめる",
    "high_bold_density": "文中の強調の太字は、文書全体で本当に目立たせたい数か所だけに残す。箇条や行の頭の「**ラベル**:」は、項目を探す目印なので残してよい",
    "high_bullet_ratio": "因果や経緯のある箇条書きは地の文に戻す。宿題の一覧のように本当に独立した項目は残す",
    "boilerplate_heading": "「まとめ」「おわりに」のような見出しをやめ、結論そのものを見出しにするか、見出しなしで締める",
    "numbered_phase_structure": "内容がもともと段階を持つときだけ番号を付ける",
    "high_emoji_symbol_density": "絵文字や装飾記号を外す。区分のラベルとして働いているものだけ残す",
    "sentence_too_long": "主張が二つ以上あれば、主張ごとに文を分ける。分けて字数が増えるのはかまわない。元にない接続の言葉は足さない",
    "kanji_run": "ひらがなを交えて開く（「再送抑制機能」→「再送を止める機能」）。固有名詞はそのままでよい",
    "buried_list": "箇条書きに開く。各項目を「太字: 説明」の形にはしない",
    "double_negative": "肯定の形に直すなら、真偽が反転していないかを必ず確かめる（「招かないとは言えない」は「招くことがある」）。控えめに言うことが意図なら触らない",
    "sentence_in_paren": "括弧の中の言葉をそのまま本文に入れるか、その言葉だけで一文にする（「書きました(#512。まだレビュー前です)」→「#512 に書きました。まだレビュー前です」）。接続の言葉や、中身と本文の関係を決める言葉は足さない。エッセイの余談のように、書き手の語り口なら残す",
    "no_chain": "どこかを動詞に戻す（「上限の設定の検討」→「上限をどう設定するか検討する」）",
}


def attach_hints(findings: list[Finding]) -> list[Finding]:
    for f in findings:
        if not f.hint:
            f.hint = HINTS.get(f.category, "")
    return findings


def run_lint(
    raw_text: str, genre: str | None = None, experimental: bool = False
) -> tuple[list[Finding], dict]:
    """genre: "essay" | "tech" | "business" | None。指定するとジャンル別に校正した
    閾値プロファイル（GENRE_PROFILES）を適用する。指定しない場合（デフォルト）は
    共通の保守的な閾値（モジュール定数のデフォルト値）を使う。
    experimental: True にすると EXPERIMENTAL_CATEGORIES（まだ定量校正前、または
    無反応と判定された検出器）の finding も出力する。デフォルトは False で、
    それらは stats/findings から除外される。
    """
    profile = GENRE_PROFILES.get(genre, {})

    # --- 構造層検出器は Markdown マスクより前のテキストを解析するが、HTML コメント内の
    # 太字・番号付きフェーズ・絵文字を誤検知しないよう、HTML コメントのみを同じ長さの
    # 空白に置換したテキストを渡す（行番号・オフセットは raw_text と一致するため、
    # 検出器内で raw_text から excerpt を切り出す既存ロジックはそのまま使える）。
    structural_findings, structural_stats = detect_structural_ai_habits(mask_html_comments(raw_text))

    # Markdown の構造行（見出し/リスト/コードブロック/引用/表）とインラインコードスパンは
    # 文章として扱わず、行番号を保ったままマスクしてから解析用テキストとして使う。
    # ただし excerpt（レポート表示）は必ず raw_text（原文）から同じオフセットで切り出す。
    # マスクは「解析専用」であり、表示用ではないことに注意。
    text = mask_markdown_structure(raw_text)
    lines = iter_lines_with_no(text)
    raw_lines_by_no = dict(iter_lines_with_no(raw_text))
    sentences = split_sentences_with_lines(lines, raw_lines_by_no)
    # sudachipy の形態素解析結果は複数の検出器で使い回す（トークナイズは1回だけ）。
    tokenized = tokenize_sentences(sentences)

    findings: list[Finding] = []
    findings += structural_findings
    # --- 表層（正規表現）ベースの検出器 ---
    findings += detect_forbidden_phrases(lines, raw_lines_by_no)
    findings += detect_translationese(lines, raw_lines_by_no)
    findings += detect_antithesis_repetition(
        lines,
        raw_lines_by_no,
        rate_critical_above=profile.get("antithesis_rate_critical_above", ANTITHESIS_RATE_CRITICAL_ABOVE),
    )
    findings += detect_negation_repetition(lines, raw_lines_by_no)
    findings += detect_low_sentence_length_variance(sentences)
    findings += detect_english_syntax_smell(lines, raw_lines_by_no)

    # --- 形態素解析ベースの検出器（拡張: 品詞列・活用形マッチ） ---
    nominal_and_conj_findings, morph_stats = detect_nominal_ending_and_paragraph_conjunctions(
        lines,
        tokenized,
        raw_lines_by_no,
        nominal_min_chars=profile.get("nominal_min_chars", NOMINAL_ENDING_MIN_CHARS),
    )
    findings += nominal_and_conj_findings
    findings += detect_inanimate_subject_morph(tokenized)
    findings += detect_wago_nominalization(tokenized)
    # nested_attributive はコーパス校正で削除済み（上のコメント参照）。

    rhythm_findings, rhythm_stats = detect_rhythm_statistics(tokenized)
    findings += rhythm_findings

    ngram_findings, ngram_stats = detect_ngram_repetition(
        tokenized,
        lead_repeat_threshold=profile.get("lead_repeat_threshold", NGRAM_LEAD_REPEAT_THRESHOLD),
    )
    findings += ngram_findings

    lexdiv_findings, lexdiv_stats = detect_lexical_diversity(tokenized)
    findings += lexdiv_findings

    low_spec_findings, low_spec_stats = detect_low_specificity(lines, raw_lines_by_no)
    findings += low_spec_findings

    # EXPERIMENTAL_CATEGORIES はデフォルトでは除外する（--experimental でのみ出力）。
    if not experimental:
        findings = [f for f in findings if f.category not in EXPERIMENTAL_CATEGORIES]

    # ジャンルプロファイルによるカテゴリ単位の無効化（現状 business のみ使用）。
    # --experimental を付けて実験的カテゴリを表示させた場合でも、そのジャンルの
    # 正当な文書慣習と衝突すると判定された検出器はここで確実に除外する。
    disabled_categories = profile.get("disabled_categories", set())
    if disabled_categories:
        findings = [f for f in findings if f.category not in disabled_categories]

    findings.sort(key=lambda f: f.line)
    attach_hints(findings)

    stats = {
        "total_findings": len(findings),
        "by_category": {},
        "genre": genre,
        "experimental": experimental,
        **morph_stats,
        "rhythm": rhythm_stats,
        "ngram": ngram_stats,
        "lexical_diversity": lexdiv_stats,
        "structural": structural_stats,
        "low_specificity": low_spec_stats,
    }
    for f in findings:
        stats["by_category"][f.category] = stats["by_category"].get(f.category, 0) + 1

    return findings, stats


SEVERITY_LABEL = {"info": "情報", "warn": "警告", "critical": "重大"}


STATUS_LABEL = {"new": "新規", "persisting": "継続"}


def print_human_report(
    path: Path,
    findings: list[Finding],
    stats: dict,
    baseline_summary: dict[str, int] | None = None,
) -> None:
    print(f"=== lint: {path} ===")
    print(f"検出件数: {stats['total_findings']}")
    if stats["by_category"]:
        print("カテゴリ別内訳:")
        for cat, count in sorted(stats["by_category"].items(), key=lambda kv: -kv[1]):
            print(f"  - {cat}: {count}")

    # --baseline 指定時のみ、解消/新規/継続のサマリを追加表示する
    # （--baseline なしの場合はこのブロックごと出力されず、既存の挙動と完全に同じ）。
    if baseline_summary is not None:
        print(
            f"ベースライン比較: 解消: {baseline_summary['resolved']}件 / "
            f"新規: {baseline_summary['new']}件 / "
            f"継続: {baseline_summary['persisting']}件"
        )
    print()

    if not findings:
        print("検出なし。")
        return

    for f in findings:
        label = SEVERITY_LABEL.get(f.severity, f.severity)
        # baseline比較時は各行に新規/継続タグを付ける（比較しない場合は付けない＝従来どおり）
        status_tag = f"[{STATUS_LABEL.get(f.status, f.status)}] " if f.status else ""
        print(f"{status_tag}[{label}] L{f.line} ({f.category})")
        print(f"    該当箇所: {f.excerpt}")
        if f.detail:
            # 「対応箇所: L12, L34, ...」（related_lines）は detail 文字列に既に
            # 含めているため、人間可読レポートでは detail をそのまま表示すれば十分。
            print(f"    詳細    : {f.detail}")
        if f.hint:
            print(f"    直し方  : {f.hint}")
        print()


def print_reading_load_report(findings: list[Finding], stats: dict) -> None:
    """読みにくそうな箇所の検査を、AI臭さの検出結果とは視覚的にも分けて出力する。"""
    print("=== 読解負荷（推敲で見る箇所を示すだけ。自然度スコアには含まない） ===")
    print(f"指摘件数: {stats.get('total', len(findings))}（本文 {stats.get('sentences', 0)} 文）")
    if stats.get("by_category"):
        print("カテゴリ別内訳:")
        for cat, count in sorted(stats["by_category"].items(), key=lambda kv: -kv[1]):
            print(f"  - {cat}: {count}")
    print()

    if not findings:
        print("指摘なし。")
        return

    for f in findings:
        print(f"[見る箇所] L{f.line} ({f.category})")
        print(f"    該当箇所: {f.excerpt}")
        if f.detail:
            print(f"    詳細    : {f.detail}")
        if f.hint:
            print(f"    直し方  : {f.hint}")
        print()

    print("※ これらは「直すべき欠陥」ではなく「見るべき箇所」。読んで引っかからない文はいじらない。")
    print("※ 直し方は SKILL.md §5「読みやすさの点検」に従う。")


def print_paragraph_sheet(text: str) -> None:
    """段落ごとの確認(SKILL.md §3)の一覧を出す。判断はしない。

    文書を通して読むだけだと、モデルは「もう読みやすい」と判断して段落ごとの確認を
    飛ばす。別のコマンドにすると実行を省かれるので、毎回実行される lint の出力に含める。
    """
    from paragraphs import split_units

    units = split_units(text)
    print(f"=== 段落ごとの確認(全 {len(units)} 段落。既存の文書を直すときは必須。SKILL.md §3) ===")
    print("1段落ずつ、動詞と名詞をすべて見て、§3「読み手が何のことか分からない言い回し」の型に当たるものを")
    print("「番号: 言い回し → 指しているもの(元の文書やコードにある事実・名前)」の形で書き出す。")
    print("当たらない段落は「番号: なし」と書く。最後の段落まで書き出してから直す。途中で省かない。")
    print()
    for u in units:
        body = u["text"].replace("\n", " / ")
        print(f"[{u['no']}] L{u['line']} {u['kind']}: {body}")
    print()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="AI臭い日本語文章を決定的に検出する lint スクリプト（CI ゲートではない）。"
    )
    parser.add_argument("file", type=Path, help="lint 対象の Markdown/テキストファイル")
    parser.add_argument("--json", action="store_true", help="機械可読な JSON で出力する")
    parser.add_argument(
        "--baseline",
        type=Path,
        default=None,
        metavar="PREV.json",
        help=(
            "前回の --json 出力ファイルと比較し、resolved（解消）/ new（新規）/ "
            "persisting（継続）を判定する（直して lint をかけ直すたびに、指摘が減ったかを見るのに使う。"
            "指定しない場合の挙動は完全に不変）"
        ),
    )
    parser.add_argument(
        "--genre",
        choices=sorted(GENRE_PROFILES),
        default=None,
        help=(
            "文書のジャンルに応じてコーパス校正済みの閾値プロファイルを適用する"
            "（essay/tech/business）。未指定時は共通の保守的閾値を使う"
        ),
    )
    parser.add_argument(
        "--experimental",
        action="store_true",
        help=(
            "まだコーパスで定量校正されていない、またはコーパスでほとんど何も検出しなかった検出器"
            "（EXPERIMENTAL_CATEGORIES）も出力する。デフォルトでは除外される"
        ),
    )
    parser.add_argument(
        "--reading-load",
        action="store_true",
        help=(
            "読みにくそうな箇所（一文長・埋もれた列挙・連続漢字・二重否定・「の」連鎖）も"
            "出力する。AI臭さの検出とは別の検査で、推敲で見る箇所を示すだけ。"
            "自然度スコアにも --baseline 比較にも含まれない"
        ),
    )
    args = parser.parse_args()

    # 「文章の中身に関する判断」と「そもそも実行できない入力エラー」は区別する。
    # 前者（検出結果）は exit 0（lintでありCIゲートではない）、
    # 後者（ファイル不在/ディレクトリ指定/読み取り不可/非UTF-8等）は exit 1。
    text, err = read_source_file(args.file)
    if err is not None:
        print(err, file=sys.stderr)
        return 1

    baseline_data = None
    if args.baseline is not None:
        if not args.baseline.exists():
            print(f"エラー: --baseline ファイルが見つかりません: {args.baseline}", file=sys.stderr)
            return 1
        try:
            loaded_baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            print(f"エラー: --baseline ファイルを読み込めません: {args.baseline} ({exc})", file=sys.stderr)
            return 1

        # JSON としては読めても、スキーマが想定外（トップレベルが配列、findings が
        # 欠けている、findings 内の要素が dict でない等）だと compute_baseline_diff()
        # がクラッシュしうる。lint は CI ゲートではなく、baseline はあくまで補助
        # 情報なので、想定外の形式のときは実行全体を落とさず、baseline比較を諦めて
        # 通常の lint 実行にフォールバックする（警告は出す）。
        baseline_data, baseline_warnings = validate_baseline_data(loaded_baseline)
        for w in baseline_warnings:
            print(f"警告: {w}", file=sys.stderr)

    findings, stats = run_lint(text, genre=args.genre, experimental=args.experimental)

    # 読みにくそうな箇所の検査は完全に別扱いにする。findings にも stats にも混ぜず、
    # --baseline 比較（compute_baseline_diff）にも渡さない。
    reading_load_findings: list[Finding] | None = None
    reading_load_stats: dict | None = None
    if args.reading_load:
        reading_load_findings, reading_load_stats = run_reading_load(text, genre=args.genre)

    resolved: list[dict] = []
    baseline_summary: dict[str, int] | None = None
    if baseline_data is not None:
        resolved, baseline_summary = compute_baseline_diff(findings, baseline_data)

    if args.json:
        output = {
            "file": str(args.file),
            "stats": stats,
            "findings": [f.to_dict() for f in findings],
        }
        # --baseline を指定したときだけ baseline セクションを追加する
        # （指定しない場合の JSON 構造は従来と完全に同じ）。
        if baseline_summary is not None:
            output["baseline"] = {
                "file": str(args.baseline),
                "summary": baseline_summary,
                "resolved": resolved,
            }
        # --reading-load を指定したときだけ独立したセクションを追加する
        # （指定しない場合の JSON 構造は従来と完全に同じ）。
        if reading_load_findings is not None:
            output["reading_load"] = {
                "stats": reading_load_stats,
                "findings": [f.to_dict() for f in reading_load_findings],
            }
        from paragraphs import split_units

        output["paragraphs"] = split_units(text)
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        print_human_report(args.file, findings, stats, baseline_summary)
        if reading_load_findings is not None:
            print_reading_load_report(reading_load_findings, reading_load_stats or {})
        print_paragraph_sheet(text)

    # lint であって CI ゲートではない。文章の検出結果は件数に関わらず常に exit 0 とし、
    # 修正するかどうかの判断は人間（または後続の AI 自己点検フロー）に委ねる。
    return 0


if __name__ == "__main__":
    sys.exit(main())

