# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "sentence-transformers>=3.0.0",
#     "numpy",
#     "sudachipy>=0.6.8",
#     "sudachidict-core>=20240409",
# ]
# ///
"""semantic.py — 文埋め込みによる「話題の平板さ」検出（EXPERIMENTAL・opt-in）。

【重要】これは lint.py の中核パイプラインとは独立した重量級のオプトイン検出器である。
torch + sentence-transformers（cl-nagoya/ruri-v3-310m、初回~1GB級のHFダウンロード）に
依存するため、scripts/lint.py・.github/workflows/release.yml・scripts/check-fixtures.sh の
どこにも組み込まない。実行したい人だけが明示的に `uv run scripts/semantic.py` を実行する。

背景・設計思想（corpus/reports/nn-detector-sweep.md §B 参照）:
    perplexity・教師あり分類器・GiNZA係り受けの3系統は、コーパス実測の結果
    「ジャンルの文体」や「読みやすさそのもの」を AI らしさとして検出していることが判明し不採用となった。
    唯一生き残ったのが本検出器（文埋め込みによる話題平板性）で、表層の文体をどれだけ
    磨いても消えにくい「一つの話題を同じ意味距離で刻み続ける」癖を捉えている。
    ただし model 依存が重く、閾値もFP基準集合（human quality:high 81文書）の標本がまだ少ないため、
    lint.py 本体（sudachipy のみ・数秒で完結）とは別の EXPERIMENTAL な独立エントリとする。

指標定義（corpus/experiments/embedding/sweep.py と同一ロジック。すべて cos類似度、
埋め込みは normalize_embeddings=True 済みなので内積=cos類似度）:
    - coherence_flatness_range: 隣接文類似度(|i-j|==1)の max-min。狭い=話題の起伏が乏しい
      （最有力指標。primary detector として採用）。
    - semantic_repetition_max: 非隣接文ペア(|i-j|>=2)類似度の最大値。高い=言い換え反復
      （secondary/reference。severity=info）。
    - topic_jump_min: 隣接文類似度の最小値。高い=脈絡のない飛躍がない
      （secondary/reference。severity=info）。

文分割は corpus/experiments/embedding/embed_corpus.py と同じ経路
（textcore.mask_markdown_structure + split_sentences_with_lines）を使い、
実験で校正した閾値とそのまま対応するようにする。

使い方:
    uv run scripts/semantic.py <file.md> [--json] [--genre essay|tech|business]

初回実行時は cl-nagoya/ruri-v3-310m（~1GB）を HuggingFace から自動ダウンロードする
（2回目以降はHFキャッシュを再利用し、オフラインでも動作する）。

終了コード: lint.py と同じ規律。文章の中身に関する判定は exit 0（検出件数に関わらず）。
入力エラー（ファイル不在・ディレクトリ指定・読み取り不可等）のみ exit 1。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from textcore import (
    Finding,
    iter_lines_with_no,
    mask_markdown_structure,
    read_source_file,
    split_sentences_with_lines,
)

DEFAULT_MODEL = "cl-nagoya/ruri-v3-310m"

# 短文書ガード。統計的な起伏・反復の測定は文数が少ないと意味をなさない
# （lint.py の低分散検出器などが短文書を除外するのと同じ哲学）。
# コーパス実験（sweep.py）は「n>=3で計算可、n>=2でvar/range計算」という緩い下限だったが、
# 実運用の目安としては最低10文程度なければ「起伏がない」という判定自体が
# 統計的に不安定（1〜2箇所の類似度でrange/varがほぼ決まってしまう）と判断し、
# 10文未満はここで打ち切る。
MIN_SENTENCES_FOR_STATS = 10

# ---------------------------------------------------------------------------
# 閾値校正（2026-07、corpus/experiments/embedding/sweep-raw.json 542文書分の
# 生データを本スクリプト作成時に再集計して算出。算出手順は
# corpus/experiments/embedding/sweep.py の sweep_threshold() と同じ規律
# （FP基準集合＝human_fp_base で誤検知率<5%を保ちつつAI検出率最大の閾値を
# value<=th / value>=th の両方向から全探索）。
#
# coherence_flatness_range（primary、severity=warn。隣接文類似度のレンジが
# 狭い＝話題の起伏が乏しい）:
#   - 全ジャンル共通（デフォルト）: threshold=0.1612 (value<=th) →
#     n(fp_base)=81, FP率=3.7%, n(ai)=405, AI検出率=85.2%
#     （corpus/reports/nn-detector-sweep.md §B の実験結果そのまま）
#   - ジャンル別再校正（本スクリプト作成時に実施。essayのFP率問題への対応）:
#     essayは共通閾値0.1612適用時にFP率6.7%（n=30中2件）とレポートで指摘された
#     問題ジャンル。essay単体のFP基準集合(n=30)とAI(n=84)で再スイープした結果、
#     threshold=0.1581 (value<=th) でFP率=3.3%（1/30）、AI検出率=95.2%（80/84）と
#     大幅改善（かつ検出率はむしろ上昇）。
#     tech: n(fp_base)=18, threshold=0.1426 (value<=th) → FP率=0%（0/18）,
#     n(ai)=84, AI検出率=52.4%（44/84）。tech人間コーパスは見出し・箇条書き構成に
#     寄るぶん元々flatness_rangeが高め（mean=0.2063）で、閾値を厳しく（低く）
#     しないとFP<5%を保てない。
#     business: n(fp_base)=29, threshold=0.1556 (value<=th) → FP率=0%（0/29）,
#     n(ai)=84, AI検出率=73.8%（62/84）。
#   注意: essay(0.1581) > business(0.1556) > tech(0.1426) の順で、essayが
#   3ジャンル中もっとも「緩い」（=値が高くても発火しにくい方向に振っている
#   わけではなく、essay固有のFP基準集合の分布の谷間を使って全体閾値0.1612より
#   厳しくした結果、3ジャンル中では最も高い値になった）。数値上essayの
#   閾値がtech/businessより高いのは、essay固有の人間分布が0.134と0.161の
#   間に空白域を持つため、この空白の直下（0.1581）まで閾値を上げても
#   FP<5%を保てるという、経験的な校正結果である。
# ---------------------------------------------------------------------------
DEFAULT_FLATNESS_THRESHOLD = 0.16122889518737793

GENRE_PROFILES: dict[str, dict] = {
    "essay": {
        "flatness_threshold": 0.15813499689102173,
        "flatness_calibration": "n(fp_base)=30, FP率=3.3%, n(ai)=84, AI検出率=95.2%",
    },
    "tech": {
        "flatness_threshold": 0.14261949062347412,
        "flatness_calibration": "n(fp_base)=18, FP率=0%, n(ai)=84, AI検出率=52.4%",
    },
    "business": {
        "flatness_threshold": 0.15565699338912964,
        "flatness_calibration": "n(fp_base)=29, FP率=0%, n(ai)=84, AI検出率=73.8%",
    },
}

# secondary/reference 指標（severity=info）。全ジャンル共通閾値のみ
# （corpus/experiments/embedding/sweep-result.md の全体スイープ結果をそのまま流用。
# ジャンル別再校正はprimary指標のみに絞り、これらは参考情報にとどめる）。
SEMANTIC_REPETITION_MAX_THRESHOLD = 0.9322158694267273  # value<=th → FP率4.9%(n=81), AI検出率46.4%(n=405)
TOPIC_JUMP_MIN_THRESHOLD = 0.765757143497467  # value>=th → FP率4.9%(n=81), AI検出率62.2%(n=405)


def doc_sentences_with_lines(raw_text: str) -> list[tuple[int, str]]:
    """(行番号, 原文の文) のリストを返す。embed_corpus.py の doc_sentences と
    同じ経路（マスク済みテキストで文分割→原文から同オフセットで切り出し）だが、
    ここでは行番号も保持して Finding.line に使えるようにする。"""
    masked = mask_markdown_structure(raw_text)
    lines = iter_lines_with_no(masked)
    raw_lines_by_no = dict(iter_lines_with_no(raw_text))
    sentences = split_sentences_with_lines(lines, raw_lines_by_no)
    out = []
    for no, masked_s, raw_s in sentences:
        s = raw_s.strip() if raw_s.strip() else masked_s.strip()
        if s:
            out.append((no, s))
    return out


_model_cache = {}


def load_model(model_name: str):
    """初回ロード時だけ ~1GB ダウンロードの可能性を stderr に警告する。"""
    if model_name in _model_cache:
        return _model_cache[model_name]

    print(
        f"[semantic.py] モデル読み込み中: {model_name} "
        "（初回実行時はHuggingFaceから自動ダウンロード、~1GB級の可能性があります。"
        "2回目以降はHFキャッシュを再利用しオフラインでも動作します）",
        file=sys.stderr,
    )
    import torch
    from sentence_transformers import SentenceTransformer

    device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    model = SentenceTransformer(model_name, device=device, trust_remote_code=True)
    _model_cache[model_name] = model
    return model


def compute_metrics(embeddings) -> dict:
    """corpus/experiments/embedding/sweep.py の cosine_matrix_stats と同一ロジック。"""
    import numpy as np

    n = embeddings.shape[0]
    out = {
        "semantic_repetition_max": None,
        "coherence_flatness_range": None,
        "topic_jump_min": None,
    }
    if n < 3:
        return out
    sim = embeddings @ embeddings.T

    adj = np.array([sim[i, i + 1] for i in range(n - 1)])
    if len(adj) >= 2:
        out["coherence_flatness_range"] = float(adj.max() - adj.min())
        out["topic_jump_min"] = float(adj.min())
    elif len(adj) == 1:
        out["topic_jump_min"] = float(adj[0])

    iu = np.triu_indices(n, k=2)
    non_adj = sim[iu]
    if non_adj.size:
        out["semantic_repetition_max"] = float(non_adj.max())

    return out


def run_semantic(
    raw_text: str, genre: str | None = None, model_name: str = DEFAULT_MODEL
) -> tuple[list[Finding], dict]:
    profile = GENRE_PROFILES.get(genre, {})
    flatness_threshold = profile.get("flatness_threshold", DEFAULT_FLATNESS_THRESHOLD)
    flatness_calibration = profile.get(
        "flatness_calibration",
        "n(fp_base)=81, FP率=3.7%, n(ai)=405, AI検出率=85.2%（全ジャンル共通閾値）",
    )

    sentence_items = doc_sentences_with_lines(raw_text)
    n_sentences = len(sentence_items)

    stats: dict = {
        "genre": genre,
        "n_sentences": n_sentences,
        "model": model_name,
        "flatness_threshold": flatness_threshold,
        "metrics": None,
        "skipped": False,
        "skip_reason": None,
    }

    if n_sentences < MIN_SENTENCES_FOR_STATS:
        stats["skipped"] = True
        stats["skip_reason"] = (
            f"文数が{n_sentences}文と少なく（目安{MIN_SENTENCES_FOR_STATS}文未満）、"
            "統計的な起伏・反復の測定が安定しないため意味的検出をスキップしました。"
        )
        return [], stats

    lines_no = [no for no, _ in sentence_items]
    sentences = [s for _, s in sentence_items]

    model = load_model(model_name)
    embeddings = model.encode(
        sentences, convert_to_numpy=True, show_progress_bar=False, normalize_embeddings=True
    )
    metrics = compute_metrics(embeddings)
    stats["metrics"] = metrics

    findings: list[Finding] = []

    cfr = metrics.get("coherence_flatness_range")
    if cfr is not None and cfr <= flatness_threshold:
        # レポート対象行はとりあえず文書冒頭（文単位ではなく文書全体集計の検出器なので、
        # lint.py の antithesis_repetition 等の「文書全体集計型」の扱いに倣う）。
        line = lines_no[0] if lines_no else 1
        findings.append(
            Finding(
                line=line,
                category="semantic_topic_flatness",
                excerpt=f"隣接文類似度レンジ={cfr:.4f}（閾値{flatness_threshold:.4f}以下）",
                severity="warn",  # 実験的検出器のため critical にはしない
                detail=(
                    "隣接文の意味類似度の起伏が乏しい=一つの話題を同じ歩幅で刻み続ける"
                    "AI的な平板さの疑い。EXPERIMENTAL: コーパス校正では"
                    f"{flatness_calibration}（corpus/experiments/embedding/sweep-raw.json "
                    "542文書からの実測。genre指定なしはcorpus/reports/nn-detector-sweep.md "
                    "の全体閾値をそのまま使用）。具体例への降下・視点の転換・短い脱線で"
                    "意味的な緩急をつけることを検討してください。"
                ),
            )
        )

    srm = metrics.get("semantic_repetition_max")
    if srm is not None and srm <= SEMANTIC_REPETITION_MAX_THRESHOLD:
        line = lines_no[0] if lines_no else 1
        findings.append(
            Finding(
                line=line,
                category="semantic_repetition_max",
                excerpt=f"非隣接文ペア類似度max={srm:.4f}（参考閾値{SEMANTIC_REPETITION_MAX_THRESHOLD:.4f}以下）",
                severity="info",
                detail=(
                    "参考指標（experimental・reference）。非隣接文ペアの意味的類似度の"
                    "最大値が低め＝同じ内容の言い換え反復が少ないことを示す（低いほどAI寄り、"
                    "という逆説的な弁別だが、コーパス実測ではhuman_fp_base mean=0.9878 vs "
                    "ai mean=0.9470とAI側が低い）。n(fp_base)=81, FP率=4.9%, n(ai)=405, "
                    "AI検出率=46.4%（corpus/experiments/embedding/sweep-result.md）。"
                ),
            )
        )

    tjm = metrics.get("topic_jump_min")
    if tjm is not None and tjm >= TOPIC_JUMP_MIN_THRESHOLD:
        line = lines_no[0] if lines_no else 1
        findings.append(
            Finding(
                line=line,
                category="topic_jump_min",
                excerpt=f"隣接文類似度最小値={tjm:.4f}（参考閾値{TOPIC_JUMP_MIN_THRESHOLD:.4f}以上）",
                severity="info",
                detail=(
                    "参考指標（experimental・reference）。隣接文間で意味的に大きく飛躍する"
                    "箇所が無い＝脈絡のない話題転換が少ないことを示す。"
                    "n(fp_base)=81, FP率=4.9%, n(ai)=405, AI検出率=62.2%"
                    "（corpus/experiments/embedding/sweep-result.md）。"
                ),
            )
        )

    return findings, stats


SEVERITY_LABEL = {"info": "情報", "warn": "警告", "critical": "重大"}


def print_human_report(path: Path, findings: list[Finding], stats: dict) -> None:
    print(f"=== semantic.py (EXPERIMENTAL): {path} ===")
    print(f"文数: {stats['n_sentences']}  モデル: {stats['model']}  genre: {stats['genre'] or '(未指定)'}")
    if stats["skipped"]:
        print(f"スキップ: {stats['skip_reason']}")
        return
    print(f"検出件数: {len(findings)}")
    print()
    if not findings:
        print("検出なし。")
        return
    for f in findings:
        label = SEVERITY_LABEL.get(f.severity, f.severity)
        print(f"[{label}] L{f.line} ({f.category})")
        print(f"    該当箇所: {f.excerpt}")
        if f.detail:
            print(f"    詳細    : {f.detail}")
        print()


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "EXPERIMENTAL: 文埋め込みによる話題平板性の検出（opt-in・重量級・"
            "torch+sentence-transformers依存、初回~1GBダウンロード）。"
            "lint.py とは独立したエントリポイント。"
        )
    )
    parser.add_argument("file", type=Path, help="検査対象の Markdown/テキストファイル")
    parser.add_argument("--json", action="store_true", help="機械可読な JSON で出力する")
    parser.add_argument(
        "--genre",
        choices=sorted(GENRE_PROFILES),
        default=None,
        help="ジャンル別に校正した閾値プロファイルを適用する（essay/tech/business）。未指定時は共通閾値",
    )
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"埋め込みモデル名（既定: {DEFAULT_MODEL}）")
    args = parser.parse_args()

    text, err = read_source_file(args.file)
    if err is not None:
        print(err, file=sys.stderr)
        return 1

    try:
        findings, stats = run_semantic(text, genre=args.genre, model_name=args.model)
    except Exception as exc:
        print(
            f"エラー: 意味モデルの読み込みまたは推論に失敗しました: {exc}",
            file=sys.stderr,
        )
        return 1

    if args.json:
        output = {
            "file": str(args.file),
            "stats": stats,
            "findings": [f.to_dict() for f in findings],
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        print_human_report(args.file, findings, stats)

    # lint.py と同じ規律: 文章の中身に関する判定は exit 0（件数に関わらず）。
    return 0


if __name__ == "__main__":
    sys.exit(main())
