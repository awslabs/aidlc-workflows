// covers: docs-gate:links-reach-a-page
//
// The docs are read in two places: on GitHub, where the README sends people,
// and on the published site, which zensical builds from docs/ only. A link
// has to open its page and its section in both, and the site's menu has to
// list every page. Each page is rendered with Bun.markdown (the renderer
// markdownBlocks is built on), so headings, links (reference links included)
// and explicit anchors come from the renderer's own output, never from a
// scanner of ours, and a link inside code is not a link.
//
// A link to a folder inside docs/ needs that folder's README.md or index.md,
// the only pages the site builds for a folder. An explicit anchor in a heading
// goes at its end with no space before it: first, it takes the heading's words
// out of the link in the site's "on this page" menu; after a space, GitHub
// keeps the space as a trailing hyphen in the heading's own anchor.
//
// A link from one docs page to another must name its heading the way GitHub
// anchors it AND the way the site does, or an explicit <a id> / <a name> on
// the target page. Any other link (from a root page, read on GitHub only, or
// to a file outside docs/, which scripts/docs-rewrite-links.ts turns into a
// GitHub address for the site) needs only GitHub's anchor.
//
// The two anchor rules are the renderers' own. GitHub (github-slugger) takes
// the heading's rendered text, lower-cases it, drops punctuation, turns each
// space into a hyphen and keeps every hyphen; a repeat gets -1, -2. The site
// (Python-Markdown's toc, which zensical.toml does not override) keeps ASCII
// only, drops punctuation, trims, and turns each run of spaces and hyphens into
// one hyphen; a repeat gets _1, _2. They differ on a heading with a spaced
// hyphen or dash, a `--flag`, or a trailing inline anchor (GitHub keeps the
// space before it as a trailing hyphen).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { REPO_ROOT } from "../harness/fixtures.ts";

const DOCS = join(REPO_ROOT, "docs");
const posix = (path: string): string => path.split(sep).join("/");
const shown = (abs: string): string => posix(relative(REPO_ROOT, abs));
const inDocs = (abs: string): boolean => abs.startsWith(DOCS + sep);

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...markdownFiles(abs));
    else if (name.endsWith(".md")) out.push(abs);
  }
  return out;
}

const DOC_PAGES = markdownFiles(DOCS);
const ROOT_PAGES = readdirSync(REPO_ROOT).filter((name) => name.endsWith(".md")).sort()
  .map((name) => join(REPO_ROOT, name));

function decode(html: string): string {
  return html.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// The rendered page, with a BOM and CRLF taken out first (a Windows clone).
const rendered = new Map<string, string>();
function render(abs: string): string {
  let html = rendered.get(abs);
  if (html === undefined) {
    const source = readFileSync(abs, "utf-8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    html = Bun.markdown.html(source);
    rendered.set(abs, html);
  }
  return html;
}

function githubAnchor(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}

function siteAnchor(text: string): string {
  return text.normalize("NFKD").replace(/[^\p{ASCII}]/gu, "").replace(/[^\w\s-]/g, "").trim()
    .toLowerCase().replace(/[-\s]+/g, "-");
}

interface Anchors {
  github: Set<string>;
  site: Set<string>;
  explicit: Set<string>;
}

const anchorCache = new Map<string, Anchors>();
function anchorsOf(abs: string): Anchors {
  const cached = anchorCache.get(abs);
  if (cached) return cached;
  const html = render(abs);
  const found: Anchors = { github: new Set(), site: new Set(), explicit: new Set() };
  const seenGithub = new Map<string, number>();
  const seenSite = new Map<string, number>();
  for (const match of html.matchAll(/<h[1-6]>([\s\S]*?)<\/h[1-6]>/g)) {
    const text = decode(match[1].replace(/<[^>]*>/g, ""));
    const github = githubAnchor(text);
    const githubSeen = seenGithub.get(github) ?? 0;
    seenGithub.set(github, githubSeen + 1);
    found.github.add(githubSeen === 0 ? github : `${github}-${githubSeen}`);
    const site = siteAnchor(text);
    const siteSeen = seenSite.get(site) ?? 0;
    seenSite.set(site, siteSeen + 1);
    found.site.add(siteSeen === 0 ? site : `${site}_${siteSeen}`);
  }
  for (const match of html.matchAll(/<a\s[^>]*\b(?:id|name)="([^"]+)"/g)) found.explicit.add(decode(match[1]));
  anchorCache.set(abs, found);
  return found;
}

interface Link {
  from: string;
  href: string;
  target: string;
  fragment: string | null;
}

// Every relative link a page renders; a bare #fragment targets the page itself.
function linksOf(abs: string): Link[] {
  const out: Link[] = [];
  for (const match of render(abs).matchAll(/<a\s[^>]*\bhref="([^"]*)"/g)) {
    const href = decode(match[1]);
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    const hash = href.indexOf("#");
    const path = hash < 0 ? href : href.slice(0, hash);
    const fragment = hash < 0 ? null : href.slice(hash + 1);
    out.push({ from: abs, href, target: path === "" ? abs : resolve(dirname(abs), decodeURI(path)), fragment });
  }
  return out;
}

const ALL_LINKS = [...DOC_PAGES, ...ROOT_PAGES].flatMap(linksOf);

describe("docs links open their page and section on GitHub and on the docs site", () => {
  test("every section link names its heading the way each renderer that shows it anchors it", () => {
    const misses: string[] = [];
    for (const link of ALL_LINKS) {
      if (!link.fragment || !link.target.endsWith(".md") || !existsSync(link.target)) continue;
      const anchors = anchorsOf(link.target);
      if (anchors.explicit.has(link.fragment)) continue;
      const onGithub = anchors.github.has(link.fragment);
      const onSite = anchors.site.has(link.fragment);
      const bothShowIt = inDocs(link.from) && inDocs(link.target);
      if (onGithub && (onSite || !bothShowIt)) continue;
      const where = !bothShowIt ? "not on GitHub" : onSite ? "on the site only" : onGithub ? "on GitHub only" : "on neither";
      misses.push(`${shown(link.from)} -> ${link.href} (${where})`);
    }
    expect(misses).toEqual([]);
  });

  test("an explicit anchor in a heading comes last", () => {
    // The site copies a heading into its "on this page" menu inside a link; an
    // anchor first ends that link before the heading's words, so they cannot
    // be clicked there. At the end, the words stay inside the link.
    const anchor = /<a\s[^>]*\b(?:id|name)="[^"]+"[^>]*><\/a>/;
    const trailing = new RegExp(`(?:${anchor.source})\\s*$`);
    const first: string[] = [];
    for (const page of DOC_PAGES) {
      for (const match of render(page).matchAll(/<h[1-6]>([\s\S]*?)<\/h[1-6]>/g)) {
        let words = match[1];
        while (trailing.test(words)) words = words.replace(trailing, "");
        if (anchor.test(words)) first.push(`${shown(page)}: ${decode(match[1].replace(/<[^>]*>/g, "")).trim()}`);
      }
    }
    expect(first).toEqual([]);
  });

  test("a link to a folder in docs/ lands on a page: the folder has a README.md or index.md", () => {
    // GitHub shows any folder; the site builds a page for one only from those two files.
    const folders = ALL_LINKS
      .filter((link) => inDocs(link.target) && existsSync(link.target) && statSync(link.target).isDirectory() &&
        !existsSync(join(link.target, "README.md")) && !existsSync(join(link.target, "index.md")))
      .map((link) => `${shown(link.from)} -> ${link.href}`);
    expect(folders).toEqual([]);
  });
});

// Pages kept out of the menu on purpose: each only says where its guide moved.
const OUTSIDE_THE_MENU = ["guide/harnesses/kiro-cli.md", "guide/harnesses/kiro-ide.md"];

describe("the docs site's menu", () => {
  const config = Bun.TOML.parse(readFileSync(join(REPO_ROOT, "zensical.toml"), "utf-8")) as { nav?: unknown };
  const entries: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") entries.push(value);
    else if (Array.isArray(value)) for (const item of value) collect(item);
    else if (value && typeof value === "object") for (const item of Object.values(value)) collect(item);
  };
  collect(config.nav);

  test("lists every docs page except the moved-guide notes", () => {
    const listed = new Set(entries);
    const missing = DOC_PAGES.map((abs) => posix(relative(DOCS, abs)))
      .filter((page) => !listed.has(page) && !OUTSIDE_THE_MENU.includes(page));
    expect(missing).toEqual([]);
  });

  test("every entry is a docs page, and no moved-guide note is listed", () => {
    expect(entries.filter((page) => !existsSync(join(DOCS, page)))).toEqual([]);
    expect(entries.filter((page) => OUTSIDE_THE_MENU.includes(page))).toEqual([]);
  });
});
