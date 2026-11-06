# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "sudachipy>=0.6.8",
#     "sudachidict-core>=20240409",
# ]
# ///
"""calibrate.py — corpus/ を使って scripts/lint.py の検出器を統計的に校正する。

設計:
    scripts/lint.py を subprocess で --json 実行するのではなく、importlib で
    同ディレクトリの lint.py を直接モジュールとしてロードし、検出関数を
    直接呼ぶ。理由: sweep サブコマンドで検出器の内部閾値パラメータ（例:
    burstiness_threshold）を変えながら何度も評価する必要があり、subprocess 越しの
    CLI 呼び出しではプロセス起動コストと閾値受け渡しの両方がボトルネックになる。
    lint.py 側は、この用途のためにすべての検出関数の閾値を「デフォルト値
    付きのキーワード引数（モジュールレベル定数がデフォルト）」として公開しており、
    引数を渡さなければ CLI と完全に同じ挙動になる。
    lint.py は textcore.py（sudachi トークナイザ・マスク処理・文分割等の共有基盤、
    scripts/outline.py・scripts/terms.py とも共用）に依存する。`uv run
    scripts/calibrate.py` 実行時は sys.path[0] が scripts/ ディレクトリになるため、
    importlib で読み込んだ lint.py 内部の `from textcore import ...` もそのまま解決できる。

使い方:
    uv run scripts/calibrate.py report
    uv run scripts/calibrate.py sweep --detector low_burstiness
    uv run scripts/calibrate.py length-analysis

出力は corpus/reports/ に Markdown + JSON で保存する（.gitignore 対象）。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[2]  # scripts/ -> natural-japanese/ -> skills/ -> repo root
CORPUS_DIR = REPO_ROOT / "corpus"
REPORTS_DIR = CORPUS_DIR / "reports"


def load_lint_module():
    """scripts/lint.py をモジュールとして読み込む。

    lint.py 自体はハイフンを含まない通常のモジュール名になったが、
    calibrate.py が sweep サブコマンドで検出関数を直接呼び、実行のたびに
    パス経由でロードし直せるようにする設計は変えていないため、
    importlib.util.spec_from_file_location による明示ロードを維持する。
    """
    lint_path = SCRIPT_DIR / "lint.py"
    spec = importlib.util.spec_from_file_location("lint", lint_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"lint.py をロードできません: {lint_path}")
    module = importlib.util.module_from_spec(spec)
    # dataclasses は cls.__module__ から sys.modules を引いて型解決するため、
    # exec_module() の前に sys.modules へ登録しておく必要がある
    # （登録しないと Finding/TokenizedSentence 等の @dataclass 定義で
    # 「'NoneType' object has no attribute '__dict__'」になる）。
    sys.modules["lint"] = module
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# コーパス読み込み
# ---------------------------------------------------------------------------


@dataclass
class CorpusDoc:
    corpus_type: str  # "human_aozora" | "human_web" | "ai"
    path: Path
    text: str
    char_count: int = field(init=False)

    def __post_init__(self) -> None:
        self.char_count = len(self.text)


def _read_texts(directory: Path, patterns: list[str]) -> list[Path]:
    if not directory.exists():
        return []
    files: list[Path] = []
    for pat in patterns:
        files.extend(sorted(directory.rglob(pat)))
    return files


def _load_sources_genre_map() -> dict[str, str]:
    """corpus/sources.json の id -> genre マップを返す（business 判定用）。
    ファイルが無い/壊れている場合は空 dict を返す（コーパスが部分的でも動く要件）。
    """
    sources_path = CORPUS_DIR / "sources.json"
    if not sources_path.exists():
        return {}
    try:
        entries = json.loads(sources_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return {e.get("id"): e.get("genre") for e in entries if isinstance(e, dict) and e.get("id")}


def load_corpus() -> dict[str, list[CorpusDoc]]:
    """corpus/human/aozora, corpus/human/web, corpus/ai/**  を読み込む。
    存在しないディレクトリ・0件のディレクトリがあっても構わない
    （コーパスが部分的でも動く要件）。読めないファイル（binary 等）はスキップする。

    加えて、business ジャンル校正用に human_business / ai_business の集合も作る。
    human 側は corpus/sources.json の genre=="business" で判定（human/web 配下の
    biz-* ファイル）。ai 側はファイル名が "business-" で始まるかで判定
    （corpus/ai/<model>/business-*.md の命名規則に依拠）。
    どちらも上記の human_web / ai 集合の部分集合であり、二重集計にはならない
    （report のマトリクスでは別列として並べて表示するだけ）。
    """
    groups: dict[str, list[CorpusDoc]] = {
        "human_aozora": [],
        "human_web": [],
        "human_business": [],
        "ai": [],
        "ai_business": [],
    }

    genre_map = _load_sources_genre_map()

    aozora_files = _read_texts(CORPUS_DIR / "human" / "aozora", ["*.txt", "*.md"])
    for p in aozora_files:
        try:
            text = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if text.strip():
            groups["human_aozora"].append(CorpusDoc("human_aozora", p, text))

    web_files = _read_texts(CORPUS_DIR / "human" / "web", ["*.md", "*.txt"])
    for p in web_files:
        try:
            text = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if text.strip():
            groups["human_web"].append(CorpusDoc("human_web", p, text))
            if genre_map.get(p.stem) == "business":
                groups["human_business"].append(CorpusDoc("human_business", p, text))

    ai_files = _read_texts(CORPUS_DIR / "ai", ["*.md", "*.txt"])
    for p in ai_files:
        try:
            text = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if text.strip():
            groups["ai"].append(CorpusDoc("ai", p, text))
            if p.name.startswith("business-"):
                groups["ai_business"].append(CorpusDoc("ai_business", p, text))

    return groups


# ---------------------------------------------------------------------------
# 前処理: 1文書につき1回だけ lines/sentences/tokenized を作る
# （sweep で同じ文書に対して何度も検出関数を呼ぶため、形態素解析等の重い処理を
# 使い回すためのキャッシュ）。
# ---------------------------------------------------------------------------


@dataclass
class PreparedDoc:
    doc: CorpusDoc
    lines: list
    raw_lines_by_no: dict
    sentences: list
    tokenized: list
    findings: list = field(default_factory=list)
    stats: dict = field(default_factory=dict)


def prepare_doc(mod, doc: CorpusDoc) -> PreparedDoc:
    text = mod.mask_markdown_structure(doc.text)
    lines = mod.iter_lines_with_no(text)
    raw_lines_by_no = dict(mod.iter_lines_with_no(doc.text))
    sentences = mod.split_sentences_with_lines(lines, raw_lines_by_no)
    tokenized = mod.tokenize_sentences(sentences)
    return PreparedDoc(
        doc=doc, lines=lines, raw_lines_by_no=raw_lines_by_no, sentences=sentences, tokenized=tokenized
    )


def run_full_lint(mod, prepared: PreparedDoc) -> None:
    """通常の run_lint() 相当を、既に prepare_doc() 済みの中間データを使って実行し、
    prepared.findings / prepared.stats を埋める（report / length-analysis 用）。
    run_lint() 自体は文書全体を再度 mask/split/tokenize してしまうため、
    ここでは中間データを再利用する軽量版として組み立て直す。
    """
    findings = []
    findings += mod.detect_forbidden_phrases(prepared.lines, prepared.raw_lines_by_no)
    findings += mod.detect_translationese(prepared.lines, prepared.raw_lines_by_no)
    findings += mod.detect_antithesis_repetition(prepared.lines, prepared.raw_lines_by_no)
    findings += mod.detect_low_sentence_length_variance(prepared.sentences)
    findings += mod.detect_english_syntax_smell(prepared.lines, prepared.raw_lines_by_no)

    nominal_and_conj_findings, morph_stats = mod.detect_nominal_ending_and_paragraph_conjunctions(
        prepared.lines, prepared.tokenized, prepared.raw_lines_by_no
    )
    findings += nominal_and_conj_findings
    findings += mod.detect_translationese_morph(prepared.tokenized)
    findings += mod.detect_inanimate_subject_morph(prepared.tokenized)
    # nested_attributive は 2026-07 コーパス校正で削除済み（弁別力なし）。

    rhythm_findings, rhythm_stats = mod.detect_rhythm_statistics(prepared.tokenized)
    findings += rhythm_findings

    ngram_findings, ngram_stats = mod.detect_ngram_repetition(prepared.tokenized)
    findings += ngram_findings

    lexdiv_findings, lexdiv_stats = mod.detect_lexical_diversity(prepared.tokenized)
    findings += lexdiv_findings

    low_spec_findings, low_spec_stats = mod.detect_low_specificity(prepared.lines, prepared.raw_lines_by_no)
    findings += low_spec_findings

    # 構造層検出器（2026-07新設）はマスク前の raw テキストに対して働く。
    # calibrate.py は run_lint() の EXPERIMENTAL_CATEGORIES フィルタを経由しない
    # （個別の detect_* を直接呼ぶ設計）ため、実験的カテゴリの生の発火率もそのまま
    # report/length-analysis に出る。これは意図的（校正のためにこそ実データが要る）。
    structural_findings, structural_stats = mod.detect_structural_ai_habits(prepared.doc.text)
    findings += structural_findings

    prepared.findings = findings
    prepared.stats = {
        **morph_stats,
        "rhythm": rhythm_stats,
        "ngram": ngram_stats,
        "lexical_diversity": lexdiv_stats,
        "structural": structural_stats,
        "low_specificity": low_spec_stats,
    }


# 検出器カテゴリの一覧（report のマトリクス行に使う）。lint.py の
# run_lint() が生成しうる category と対応させている。
# nested_attributive は 2026-07 コーパス校正で検出器ごと削除（弁別力なし）。
ALL_CATEGORIES = [
    "forbidden_phrase",
    "translationese",
    "translationese_morph",
    "antithesis_repetition",
    "low_sentence_variance",
    "english_syntax_inanimate_subject",
    "english_syntax_cleft_because",
    "inanimate_subject_morph",
    "nominal_ending",
    "paragraph_lead_conjunction",
    "uniform_paragraph_structure",
    "low_burstiness",
    "high_length_autocorrelation",
    "repeated_sentence_lead",
    "repeated_syntax_template",
    "low_lexical_diversity_ttr",
    "low_lexical_diversity_mtld",
    # 構造層検出器（2026-07新設、マスク前の raw テキストが対象）
    "high_bold_density",
    "high_bullet_ratio",
    "boilerplate_heading",
    "numbered_phase_structure",
    "high_emoji_symbol_density",
    "low_specificity",
]

# 統計指標系検出器（文書長に応じて弁別力が変わるもの。length-analysis の対象）。
STATISTICAL_CATEGORIES = [
    "low_sentence_variance",
    "low_burstiness",
    "high_length_autocorrelation",
    "nominal_ending",
    "paragraph_lead_conjunction",
    "uniform_paragraph_structure",
    "repeated_syntax_template",
    "low_lexical_diversity_ttr",
    "low_lexical_diversity_mtld",
    "low_specificity",
]


# ---------------------------------------------------------------------------
# report サブコマンド
# ---------------------------------------------------------------------------


def cmd_report(mod) -> None:
    groups = load_corpus()
    prepared_by_type: dict[str, list[PreparedDoc]] = {}
    for corpus_type, docs in groups.items():
        prepared_list = []
        for doc in docs:
            prepared = prepare_doc(mod, doc)
            run_full_lint(mod, prepared)
            prepared_list.append(prepared)
        prepared_by_type[corpus_type] = prepared_list

    sample_counts = {k: len(v) for k, v in prepared_by_type.items()}

    # マトリクス: category x corpus_type -> (文書発火率, 1000字あたり件数)
    matrix: dict[str, dict[str, dict]] = {}
    for category in ALL_CATEGORIES:
        matrix[category] = {}
        for corpus_type, prepared_list in prepared_by_type.items():
            n_docs = len(prepared_list)
            if n_docs == 0:
                matrix[category][corpus_type] = {
                    "doc_fire_rate": None,
                    "per_1000_chars": None,
                    "n_docs": 0,
                }
                continue
            fired_docs = 0
            total_hits = 0
            total_chars = 0
            for p in prepared_list:
                hits = [f for f in p.findings if f.category == category]
                if hits:
                    fired_docs += 1
                total_hits += len(hits)
                total_chars += p.doc.char_count
            doc_fire_rate = fired_docs / n_docs
            per_1000 = (total_hits / total_chars * 1000) if total_chars else 0.0
            matrix[category][corpus_type] = {
                "doc_fire_rate": doc_fire_rate,
                "per_1000_chars": per_1000,
                "n_docs": n_docs,
                "fired_docs": fired_docs,
            }

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    json_path = REPORTS_DIR / "report.json"
    md_path = REPORTS_DIR / "report.md"

    json_path.write_text(
        json.dumps(
            {"sample_counts": sample_counts, "matrix": matrix},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    lines_out = []
    lines_out.append("# calibrate.py report — 検出器×コーパス種別ヒット率マトリクス")
    lines_out.append("")
    lines_out.append(
        f"標本数: human_aozora={sample_counts['human_aozora']}件, "
        f"human_web={sample_counts['human_web']}件（うち business={sample_counts['human_business']}件）, "
        f"ai={sample_counts['ai']}件（うち business={sample_counts['ai_business']}件）"
    )
    lines_out.append("")
    lines_out.append(
        "各セルは「文書発火率（1件以上検出した文書の割合）／1000字あたり件数」。"
        "標本0件の種別は `-` 表記。human_business/ai_business はそれぞれ "
        "human_web/ai の部分集合（business ジャンルのみ）で、二重集計ではなく参考列。"
    )
    lines_out.append("")
    lines_out.append("| 検出器 | human_aozora | human_web | human_business | ai | ai_business |")
    lines_out.append("| --- | --- | --- | --- | --- | --- |")
    for category in ALL_CATEGORIES:
        row = [category]
        for corpus_type in ("human_aozora", "human_web", "human_business", "ai", "ai_business"):
            cell = matrix[category][corpus_type]
            if cell["n_docs"] == 0:
                row.append("-")
            else:
                row.append(f"{cell['doc_fire_rate']:.0%} / {cell['per_1000_chars']:.2f}")
        lines_out.append("| " + " | ".join(row) + " |")

    lines_out.append("")
    lines_out.append(
        "注意: human_aozora は現在12本、human_web/ai はコーパス収集・生成が"
        "進行中のため標本数が少ない場合がある。標本数が少ないカテゴリの数値は"
        "参考値として扱うこと。"
    )

    md_path.write_text("\n".join(lines_out) + "\n", encoding="utf-8")
    print(f"書き出し: {md_path}")
    print(f"書き出し: {json_path}")
    print()
    print("\n".join(lines_out))


# ---------------------------------------------------------------------------
# sweep サブコマンド
# ---------------------------------------------------------------------------


@dataclass
class DetectorSweepSpec:
    category: str
    param_name: str
    default: float
    values: list[float]
    # prepared: PreparedDoc, value: float -> bool（そのカテゴリが1件以上検出されたか）
    run: object


def _fired(findings: list, category: str) -> bool:
    return any(f.category == category for f in findings)


def build_sweep_registry(mod) -> dict[str, DetectorSweepSpec]:
    def run_low_burstiness(p: PreparedDoc, value: float) -> bool:
        findings, _ = mod.detect_rhythm_statistics(p.tokenized, burstiness_threshold=value)
        return _fired(findings, "low_burstiness")

    def run_high_length_autocorrelation(p: PreparedDoc, value: float) -> bool:
        findings, _ = mod.detect_rhythm_statistics(p.tokenized, autocorr_threshold=value)
        return _fired(findings, "high_length_autocorrelation")

    def run_low_sentence_variance(p: PreparedDoc, value: float) -> bool:
        findings = mod.detect_low_sentence_length_variance(p.sentences, threshold=value)
        return _fired(findings, "low_sentence_variance")

    def run_nominal_ending(p: PreparedDoc, value: float) -> bool:
        findings, _ = mod.detect_nominal_ending_and_paragraph_conjunctions(
            p.lines, p.tokenized, p.raw_lines_by_no, nominal_ratio_threshold=value
        )
        return _fired(findings, "nominal_ending")

    def run_paragraph_lead_conjunction(p: PreparedDoc, value: float) -> bool:
        findings, _ = mod.detect_nominal_ending_and_paragraph_conjunctions(
            p.lines, p.tokenized, p.raw_lines_by_no, conj_ratio_threshold=value
        )
        return _fired(findings, "paragraph_lead_conjunction")

    def run_uniform_paragraph_structure(p: PreparedDoc, value: float) -> bool:
        findings, _ = mod.detect_nominal_ending_and_paragraph_conjunctions(
            p.lines, p.tokenized, p.raw_lines_by_no, uniform_cv_threshold=value
        )
        return _fired(findings, "uniform_paragraph_structure")

    def run_antithesis_repetition(p: PreparedDoc, value: float) -> bool:
        findings = mod.detect_antithesis_repetition(p.lines, p.raw_lines_by_no, threshold=int(value))
        return _fired(findings, "antithesis_repetition")

    # nested_attributive は 2026-07 コーパス校正で削除済み（弁別力なし、sweep対象外）。

    def run_repeated_sentence_lead(p: PreparedDoc, value: float) -> bool:
        findings, _ = mod.detect_ngram_repetition(p.tokenized, lead_repeat_threshold=int(value))
        return _fired(findings, "repeated_sentence_lead")

    def run_repeated_syntax_template(p: PreparedDoc, value: float) -> bool:
        findings, _ = mod.detect_ngram_repetition(p.tokenized, template_ratio_threshold=value)
        return _fired(findings, "repeated_syntax_template")

    def run_low_lexical_diversity_ttr(p: PreparedDoc, value: float) -> bool:
        findings, _ = mod.detect_lexical_diversity(p.tokenized, ttr_threshold=value)
        return _fired(findings, "low_lexical_diversity_ttr")

    def run_low_lexical_diversity_mtld(p: PreparedDoc, value: float) -> bool:
        findings, _ = mod.detect_lexical_diversity(p.tokenized, mtld_threshold=value)
        return _fired(findings, "low_lexical_diversity_mtld")

    def run_low_specificity(p: PreparedDoc, value: float) -> bool:
        findings, _ = mod.detect_low_specificity(p.lines, p.raw_lines_by_no, score_threshold=value)
        return _fired(findings, "low_specificity")

    def frange(lo: float, hi: float, step: float) -> list[float]:
        n = round((hi - lo) / step)
        return [round(lo + i * step, 6) for i in range(n + 1)]

    return {
        "low_burstiness": DetectorSweepSpec(
            "low_burstiness", "burstiness_threshold", mod.BURSTINESS_THRESHOLD,
            frange(-0.9, -0.2, 0.02), run_low_burstiness,
        ),
        "high_length_autocorrelation": DetectorSweepSpec(
            "high_length_autocorrelation", "autocorr_threshold", mod.AUTOCORR_THRESHOLD,
            frange(0.1, 0.95, 0.05), run_high_length_autocorrelation,
        ),
        "low_sentence_variance": DetectorSweepSpec(
            "low_sentence_variance", "threshold", mod.SENTENCE_VARIANCE_CV_THRESHOLD,
            frange(0.05, 0.6, 0.02), run_low_sentence_variance,
        ),
        "nominal_ending": DetectorSweepSpec(
            "nominal_ending", "nominal_ratio_threshold", mod.NOMINAL_ENDING_RATIO_THRESHOLD,
            frange(0.05, 0.6, 0.02), run_nominal_ending,
        ),
        "paragraph_lead_conjunction": DetectorSweepSpec(
            "paragraph_lead_conjunction", "conj_ratio_threshold", mod.PARAGRAPH_CONJ_RATIO_THRESHOLD,
            frange(0.05, 0.7, 0.02), run_paragraph_lead_conjunction,
        ),
        "uniform_paragraph_structure": DetectorSweepSpec(
            "uniform_paragraph_structure", "uniform_cv_threshold", mod.UNIFORM_PARAGRAPH_CV_THRESHOLD,
            frange(0.02, 0.5, 0.02), run_uniform_paragraph_structure,
        ),
        "antithesis_repetition": DetectorSweepSpec(
            "antithesis_repetition", "threshold", mod.ANTITHESIS_REPETITION_THRESHOLD,
            [1, 2, 3, 4, 5, 6, 7, 8], run_antithesis_repetition,
        ),
        # nested_attributive は 2026-07 コーパス校正で削除済み（弁別力なし、sweep登録も削除）。
        "repeated_sentence_lead": DetectorSweepSpec(
            "repeated_sentence_lead", "lead_repeat_threshold", mod.NGRAM_LEAD_REPEAT_THRESHOLD,
            [1, 2, 3, 4, 5, 6, 7, 8], run_repeated_sentence_lead,
        ),
        "repeated_syntax_template": DetectorSweepSpec(
            "repeated_syntax_template", "template_ratio_threshold", mod.NGRAM_TEMPLATE_RATIO_THRESHOLD,
            frange(0.1, 0.9, 0.05), run_repeated_syntax_template,
        ),
        "low_lexical_diversity_ttr": DetectorSweepSpec(
            "low_lexical_diversity_ttr", "ttr_threshold", mod.TTR_THRESHOLD,
            frange(0.2, 0.7, 0.02), run_low_lexical_diversity_ttr,
        ),
        "low_lexical_diversity_mtld": DetectorSweepSpec(
            "low_lexical_diversity_mtld", "mtld_threshold", mod.MTLD_THRESHOLD,
            frange(10, 90, 2), run_low_lexical_diversity_mtld,
        ),
        "low_specificity": DetectorSweepSpec(
            "low_specificity", "score_threshold", mod.LOW_SPECIFICITY_SCORE_THRESHOLD,
            frange(-0.3, 0.6, 0.02), run_low_specificity,
        ),
    }


def cmd_sweep(mod, detector_name: str) -> None:
    registry = build_sweep_registry(mod)
    if detector_name not in registry:
        print(f"エラー: 未知の検出器名: {detector_name}", file=sys.stderr)
        print(f"利用可能: {', '.join(sorted(registry))}", file=sys.stderr)
        sys.exit(1)
    spec = registry[detector_name]

    groups = load_corpus()
    human_docs = groups["human_aozora"] + groups["human_web"]
    ai_docs = groups["ai"]

    human_prepared = [prepare_doc(mod, d) for d in human_docs]
    ai_prepared = [prepare_doc(mod, d) for d in ai_docs]

    curve = []
    for value in spec.values:
        human_fp = 0
        for p in human_prepared:
            try:
                if spec.run(p, value):
                    human_fp += 1
            except Exception:
                # 統計系検出器は最低サンプル数未満だと空リストを返すだけで例外は
                # 起きない設計だが、想定外の入力（極端な閾値等）でも1文書の
                # 失敗でスイープ全体が止まらないよう、例外を捕まえて読み飛ばす。
                pass
        ai_hit = 0
        for p in ai_prepared:
            try:
                if spec.run(p, value):
                    ai_hit += 1
            except Exception:
                pass
        human_fp_rate = human_fp / len(human_prepared) if human_prepared else None
        ai_detect_rate = ai_hit / len(ai_prepared) if ai_prepared else None
        curve.append(
            {
                "value": value,
                "human_fp_rate": human_fp_rate,
                "human_fp_count": human_fp,
                "ai_detect_rate": ai_detect_rate,
                "ai_detect_count": ai_hit,
            }
        )

    # 「人間FP率5%未満でAI検出率最大」の推奨閾値
    candidates = [c for c in curve if c["human_fp_rate"] is not None and c["human_fp_rate"] < 0.05]
    recommended = None
    if candidates:
        recommended = max(candidates, key=lambda c: (c["ai_detect_rate"] or 0.0))

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    json_path = REPORTS_DIR / f"sweep_{detector_name}.json"
    md_path = REPORTS_DIR / f"sweep_{detector_name}.md"

    json_path.write_text(
        json.dumps(
            {
                "detector": detector_name,
                "param_name": spec.param_name,
                "default": spec.default,
                "n_human": len(human_prepared),
                "n_ai": len(ai_prepared),
                "curve": curve,
                "recommended": recommended,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    lines_out = []
    lines_out.append(f"# calibrate.py sweep — {detector_name}")
    lines_out.append("")
    lines_out.append(f"パラメータ: `{spec.param_name}`（現行デフォルト値: {spec.default}）")
    lines_out.append(f"標本数: human={len(human_prepared)}件, ai={len(ai_prepared)}件")
    lines_out.append("")
    lines_out.append("| 値 | 人間FP率 | AI検出率 |")
    lines_out.append("| --- | --- | --- |")
    for c in curve:
        hr = f"{c['human_fp_rate']:.1%}" if c["human_fp_rate"] is not None else "-"
        ar = f"{c['ai_detect_rate']:.1%}" if c["ai_detect_rate"] is not None else "-"
        lines_out.append(f"| {c['value']} | {hr} | {ar} |")
    lines_out.append("")
    if recommended is not None:
        lines_out.append(
            f"**推奨閾値**: `{spec.param_name}={recommended['value']}`"
            f"（人間FP率={recommended['human_fp_rate']:.1%}, AI検出率={recommended['ai_detect_rate']:.1%}）"
        )
    else:
        lines_out.append(
            "**推奨閾値**: 人間FP率5%未満を満たす値が見つからなかった"
            "（標本数不足、または検出器がこのコーパスでは常に人間側にも反応する可能性）"
        )
    lines_out.append("")
    lines_out.append(
        "注意: human/ai の標本数が少ないうちは1件の増減でFP率/検出率が大きく動く。"
        "コーパス規模が拡充されるまでは参考値として扱うこと。"
    )

    md_path.write_text("\n".join(lines_out) + "\n", encoding="utf-8")
    print(f"書き出し: {md_path}")
    print(f"書き出し: {json_path}")
    print()
    print("\n".join(lines_out))


# ---------------------------------------------------------------------------
# length-analysis サブコマンド
# ---------------------------------------------------------------------------

LENGTH_BINS = [
    ("~1000字", 0, 1000),
    ("~2000字", 1000, 2000),
    ("~4000字", 2000, 4000),
    ("4000字~", 4000, None),
]


def _bin_for_length(n: int) -> str:
    for label, lo, hi in LENGTH_BINS:
        if hi is None:
            if n >= lo:
                return label
        elif lo <= n < hi:
            return label
    return LENGTH_BINS[-1][0]


def cmd_length_analysis(mod) -> None:
    groups = load_corpus()
    human_docs = groups["human_aozora"] + groups["human_web"]
    ai_docs = groups["ai"]

    human_prepared = [prepare_doc(mod, d) for d in human_docs]
    ai_prepared = [prepare_doc(mod, d) for d in ai_docs]
    for p in human_prepared + ai_prepared:
        run_full_lint(mod, p)

    # bin -> category -> {"human": {fired, total}, "ai": {fired, total}}
    result: dict[str, dict[str, dict]] = {}
    for label, _, _ in LENGTH_BINS:
        result[label] = {cat: {"human_fired": 0, "human_total": 0, "ai_fired": 0, "ai_total": 0} for cat in STATISTICAL_CATEGORIES}

    def tally(prepared_list: list[PreparedDoc], key: str) -> None:
        for p in prepared_list:
            b = _bin_for_length(p.doc.char_count)
            for cat in STATISTICAL_CATEGORIES:
                result[b][cat][f"{key}_total"] += 1
                if _fired(p.findings, cat):
                    result[b][cat][f"{key}_fired"] += 1

    tally(human_prepared, "human")
    tally(ai_prepared, "ai")

    # 各指標の「最低有効文書長」推定: そのbinで human_total>=3 かつ ai_total>=1 の
    # 最小binのうち、弁別力(ai_rate - human_rate)が正になる最小のbin下限を採用する。
    # データが薄い場合は「判定不能」とする。
    min_effective_length: dict[str, str | None] = {}
    for cat in STATISTICAL_CATEGORIES:
        found_bin = None
        for label, lo, _ in LENGTH_BINS:
            cell = result[label][cat]
            if cell["human_total"] == 0 and cell["ai_total"] == 0:
                continue
            human_rate = cell["human_fired"] / cell["human_total"] if cell["human_total"] else None
            ai_rate = cell["ai_fired"] / cell["ai_total"] if cell["ai_total"] else None
            if human_rate is not None and ai_rate is not None and ai_rate > human_rate:
                found_bin = label
                break
        min_effective_length[cat] = found_bin

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    json_path = REPORTS_DIR / "length_analysis.json"
    md_path = REPORTS_DIR / "length_analysis.md"

    json_path.write_text(
        json.dumps(
            {
                "n_human": len(human_prepared),
                "n_ai": len(ai_prepared),
                "bins": result,
                "min_effective_length_bin": min_effective_length,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    lines_out = []
    lines_out.append("# calibrate.py length-analysis — 統計指標系検出器の文書長別弁別力")
    lines_out.append("")
    lines_out.append(f"標本数: human={len(human_prepared)}件, ai={len(ai_prepared)}件")
    lines_out.append("")
    for label, _, _ in LENGTH_BINS:
        lines_out.append(f"## {label}")
        lines_out.append("")
        lines_out.append("| 検出器 | human発火率(n) | ai発火率(n) |")
        lines_out.append("| --- | --- | --- |")
        for cat in STATISTICAL_CATEGORIES:
            cell = result[label][cat]
            h = (
                f"{cell['human_fired']/cell['human_total']:.0%} (n={cell['human_total']})"
                if cell["human_total"]
                else "- (n=0)"
            )
            a = (
                f"{cell['ai_fired']/cell['ai_total']:.0%} (n={cell['ai_total']})"
                if cell["ai_total"]
                else "- (n=0)"
            )
            lines_out.append(f"| {cat} | {h} | {a} |")
        lines_out.append("")

    lines_out.append("## 推定「最低有効文書長」")
    lines_out.append("")
    lines_out.append(
        "ai発火率がhuman発火率を上回り始める最小の文書長ビン（弁別力が正になる最小ビン）。"
        "両側とも標本があるビンのみ判定対象。"
    )
    lines_out.append("")
    lines_out.append("| 検出器 | 最低有効文書長ビン |")
    lines_out.append("| --- | --- |")
    for cat in STATISTICAL_CATEGORIES:
        b = min_effective_length[cat]
        lines_out.append(f"| {cat} | {b if b else '判定不能（標本不足）'} |")
    lines_out.append("")
    lines_out.append(
        "注意: コーパスが小規模なうちはビンごとの標本数が非常に少なく、"
        "結果は暫定値。コーパス拡充後に再実行して確定させること。"
    )

    md_path.write_text("\n".join(lines_out) + "\n", encoding="utf-8")
    print(f"書き出し: {md_path}")
    print(f"書き出し: {json_path}")
    print()
    print("\n".join(lines_out))


# ---------------------------------------------------------------------------
# メイン
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="lint.py 検出器の統計校正スクリプト")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("report", help="検出器×コーパス種別のヒット率マトリクスを出力")

    sweep_parser = sub.add_parser("sweep", help="指定検出器の閾値を範囲スイープする")
    sweep_parser.add_argument("--detector", required=True, help="検出器名（例: low_burstiness）")

    sub.add_parser("length-analysis", help="統計指標系検出器の文書長別弁別力を分析する")

    args = parser.parse_args()

    mod = load_lint_module()

    if args.command == "report":
        cmd_report(mod)
    elif args.command == "sweep":
        cmd_sweep(mod, args.detector)
    elif args.command == "length-analysis":
        cmd_length_analysis(mod)

    return 0


if __name__ == "__main__":
    sys.exit(main())
