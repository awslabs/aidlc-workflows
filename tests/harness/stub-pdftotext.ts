// A stand-in `pdftotext` for tests of the default PDF extractor: CI has no
// Poppler. It answers `-v`, prints pages `-f`..`-l` of a document of `pages`
// pages ("Page N text", each ending in a form feed unless page breaks are off),
// and for a first page past the last refuses with exit 99 as Poppler does, or
// prints nothing and exits 0 as Xpdf does. A POSIX shell script, so its callers
// skip on Windows.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Write the stand-in into `<dir>/stub-bin` and return the PATH that puts it first. */
export function stubPdftotextPath(
  dir: string,
  pages: number,
  opts: { pageBreaks?: boolean; xpdf?: boolean } = {},
): string {
  const bin = join(dir, "stub-bin");
  mkdirSync(bin, { recursive: true });
  const pageEnd = opts.pageBreaks === false ? "" : "\\f";
  writeFileSync(join(bin, "pdftotext"), [
    "#!/bin/sh",
    'if [ "$1" = "-v" ]; then echo "pdftotext version 0-stub" >&2; exit 0; fi',
    `first=1; last=${pages}`,
    "while [ $# -gt 0 ]; do",
    '  case "$1" in',
    '    -f) shift; first=$1 ;;',
    `    -l) shift; [ "$1" -lt ${pages} ] && last=$1 ;;`,
    "  esac",
    "  shift",
    "done",
    opts.xpdf === true
      ? `[ "$first" -gt ${pages} ] && exit 0`
      : `[ "$first" -gt ${pages} ] && { echo "Command Line Error: Wrong page range given" >&2; exit 99; }`,
    `i=$first; while [ $i -le $last ]; do printf "Page %d text\\n${pageEnd}" $i; i=$((i+1)); done`,
    "",
  ].join("\n"), { mode: 0o755 });
  return `${bin}:${process.env.PATH ?? ""}`;
}

/** The text the stand-in prints for pages 1..`count`. */
export function stubPdfText(count: number, opts: { pageBreaks?: boolean } = {}): string {
  const pageEnd = opts.pageBreaks === false ? "" : "\f";
  return Array.from({ length: count }, (_, i) => `Page ${i + 1} text\n${pageEnd}`).join("");
}
