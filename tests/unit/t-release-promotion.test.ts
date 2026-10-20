// covers: subcommand:release-promotion
// Real Git histories prove that promotion keeps the selected preview's code
// while main advances. Only GitHub's release API is replaced.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Command, listPreviews, metadataFiles, preparePromotion, PROMOTION_FILE,
  promotionNotes, promotionSummary, RELEASE_CONTROLS, resolvePreview, syncMetadata, validateNotes, verifyPromotion,
} from "../../scripts/release-promotion.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const PREVIEW = "v2.11.1-preview.20261016.1";
const NOTES = "Compatibility: refresh only\n\nRun aidlc update, then aidlc config in each project.\n\n- Keep the chosen preview's fixes.";
const REPOSITORY = "owner/repo";
// Published version.json assets preserve the producer schemas on both sides
// of root-lifecycle support; identity fields are rebound to the local Git fixture.
const publishedManifest = (date: string) => JSON.parse(readFileSync(
  join(REPO_ROOT, `tests/fixtures/release-promotion/preview-${date}.json`), "utf8",
));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aidlc-promotion-test-"));
  roots.push(root);
  const git: Command = (program, args, input, env) => {
    const result = spawnSync(program, args, {
      cwd: root, input, encoding: "utf8",
      env: {
        ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com", ...env,
      },
    });
    if (result.status !== 0) throw new Error(`${program} ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  const put = (path: string, body: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  const commit = (message: string) => {
    git("git", ["add", "."]);
    git("git", ["commit", "-m", message]);
    return git("git", ["rev-parse", "HEAD"]).trim();
  };
  git("git", ["init", "-b", "main"]);
  put("core/tools/aidlc-version.ts", 'export const AIDLC_VERSION = "2.11.0";\n');
  put("README.md", "Old preview readme\n![version](https://img.shields.io/badge/version-2.11.0-blue)\n");
  put("CHANGELOG.md", "# Changelog\n\n## [2.11.0] - 2026-10-08\n\nPrevious release.\n");
  put("core/product.txt", "preview implementation\n");
  put(".github/workflows/retired.yml", "retired workflow\n");
  for (const path of RELEASE_CONTROLS) put(path, "previous control\n");
  const source = commit("preview source");
  git("git", ["tag", "-a", PREVIEW, "-m", `Preview\n\nSource: ${REPOSITORY}@${source}\n`]);
  const tagObject = git("git", ["rev-parse", PREVIEW]).trim();
  put("core/product.txt", "later main implementation\n");
  put("README.md", "Later main readme\n![version](https://img.shields.io/badge/version-2.11.0-blue)\n");
  for (const path of RELEASE_CONTROLS) put(path, "current control\n");
  rmSync(join(root, ".github/workflows/retired.yml"));
  put(".github/workflows/added.yml", "new reviewed workflow\n");
  const controls = commit("main moves ahead");
  const remote = mkdtempSync(join(tmpdir(), "aidlc-promotion-remote-"));
  roots.push(remote);
  git("git", ["init", "--bare", remote]);
  git("git", ["remote", "add", "origin", remote]);
  git("git", ["push", "origin", "main"]);
  const release = { tag_name: PREVIEW, prerelease: true, draft: false, published_at: "2026-10-16T23:20:35Z", body: "> **Warning:** Full Suite failed for this source." };
  const stable = { ...release, tag_name: "v2.11.0", prerelease: false };
  let taggedSource = source;
  let annotated = true;
  let manifest = { ...publishedManifest("20261016"), sourceDigest: source };
  const commands: string[][] = [];
  const run: Command = (program, args, input, env) => {
    commands.push([program, ...args]);
    if (program !== "gh") return git(program, args, input, env);
    if (args[0] === "release" && args[1] === "download") return JSON.stringify(manifest);
    if (args.includes("--paginate")) return JSON.stringify([[stable], [release]]);
    const endpoint = args.at(-1);
    if (endpoint === `repos/${REPOSITORY}/releases/tags/${PREVIEW}`) return JSON.stringify(release);
    if (endpoint === `repos/${REPOSITORY}/git/ref/tags/${PREVIEW}`) return JSON.stringify({ object: { type: annotated ? "tag" : "commit", sha: tagObject } });
    if (endpoint === `repos/${REPOSITORY}/git/tags/${tagObject}`) return JSON.stringify({
      message: `Source: ${REPOSITORY}@${source}\n`, object: { type: "commit", sha: taggedSource },
    });
    throw new Error(`unexpected API: ${args.join(" ")}`);
  };
  const prepare = () => preparePromotion({ repository: REPOSITORY, preview: PREVIEW, version: "2.11.1", controls, notes: NOTES, date: "2026-10-17" }, run);
  const tag = (sha: string) => git("git", ["tag", "-f", "v2.11.1", sha]);
  return { root, run, git, put, commit, source, controls, release, stable, prepare, tag, commands,
    setManifest: (value: typeof manifest) => { manifest = value; },
    movePreview: () => { taggedSource = controls; }, lightweight: () => { annotated = false; } };
}

describe("release promotion", () => {
  test("uses exactly the preview parent and product tree, with version and current controls", () => {
    const f = fixture();
    const result = f.prepare();
    f.tag(result.sha);
    expect(f.git("git", ["show", "-s", "--format=%P", result.sha]).trim()).toBe(f.source);
    expect(f.git("git", ["show", `${result.sha}:core/product.txt`])).toBe("preview implementation\n");
    expect(f.git("git", ["show", `${result.sha}:README.md`])).toContain("Old preview readme");
    expect(f.git("git", ["show", `${result.sha}:core/tools/aidlc-version.ts`])).toContain('"2.11.1"');
    expect(f.git("git", ["show", `${result.sha}:.github/workflows/release.yml`])).toBe("current control\n");
    expect(f.git("git", ["rev-parse", `${result.sha}:.github/workflows`]))
      .toBe(f.git("git", ["rev-parse", `${f.controls}:.github/workflows`]));
    expect(verifyPromotion("v2.11.1", REPOSITORY, f.run)).toEqual(result.promotion);
    expect(f.git("git", ["rev-parse", "HEAD"]).trim()).toBe(f.controls);
  });

  // The stable page links the preview, whose page carries its test warnings
  // and failure report; the promotion record keeps the warnings, and the
  // person promoting still sees them in the run summary.
  test("the stable page links the preview and leaves its test warnings on the preview page", () => {
    const f = fixture();
    const { promotion } = f.prepare();
    expect(promotion.warnings).toEqual([f.release.body]);
    const notes = promotionNotes(promotion);
    expect(notes).not.toContain("Full Suite failed");
    expect(notes).not.toContain("Warning");
    expect(notes).not.toContain("were not rerun or changed");
    expect(notes).toContain(`Promoted from [${PREVIEW}](https://github.com/${REPOSITORY}/releases/tag/${PREVIEW}), source \`${f.source}\`.`);
    expect(notes.endsWith(`source \`${f.source}\`.\n`)).toBe(true);
    const summary = promotionSummary(promotion);
    expect(summary.startsWith(notes)).toBe(true);
    expect(summary).toContain("Full Suite failed");
  });

  test("lists every page, includes source and warnings, and does not call missing warnings approval", () => {
    const f = fixture();
    expect(listPreviews(REPOSITORY, f.run)).toContain("Reported failures");
    expect(listPreviews(REPOSITORY, f.run)).toContain(f.source.slice(0, 12));
    f.release.body = "No result recorded.";
    expect(listPreviews(REPOSITORY, f.run)).toContain("not an approval");
    f.lightweight();
    expect(listPreviews(REPOSITORY, f.run)).toContain("Cannot verify preview source");
  });

  test("an incompatible historical preview fails before creating a release commit or tag", () => {
    const f = fixture();
    f.setManifest({ ...publishedManifest("20261013"), version: PREVIEW.slice(1), sourceDigest: f.source });
    expect(f.prepare).toThrow(/cannot promote.*version.json.*unexpected fields/i);
    expect(f.commands.some((args) => args.includes("commit-tree") || args.includes("push"))).toBe(false);
    const listing = listPreviews(REPOSITORY, f.run);
    expect(listing).toContain(f.source.slice(0, 12));
    expect(listing).toContain("Unavailable");
    expect(listing).toContain("missing: capabilities");
    expect(listing).toContain("Reported failures");
  });

  test("the preview manifest must identify the selected tag and source", () => {
    const f = fixture();
    f.setManifest({ ...publishedManifest("20261016"), sourceDigest: f.controls });
    expect(f.prepare).toThrow("authorized source");
    f.setManifest({ ...publishedManifest("20261016"), version: "2.11.1-preview.20261015.1", sourceDigest: f.source });
    expect(f.prepare).toThrow("does not match version.json");
  });

  test("a missing preview manifest cannot reserve a version and is explained in the list", () => {
    const f = fixture();
    const missing: Command = (program, args, input, env) => {
      if (program === "gh" && args[0] === "release") throw new Error("version.json asset not found");
      return f.run(program, args, input, env);
    };
    expect(() => preparePromotion({
      repository: REPOSITORY, preview: PREVIEW, version: "2.11.1",
      controls: f.controls, notes: NOTES, date: "2026-10-17",
    }, missing)).toThrow("version.json asset not found");
    expect(f.commands.some((args) => args.includes("commit-tree") || args.includes("push"))).toBe(false);
    expect(listPreviews(REPOSITORY, missing)).toContain("version.json asset not found");
  });

  test("rejects draft, stable, lightweight and mismatched preview tags", () => {
    const f = fixture();
    f.release.draft = true;
    expect(f.prepare).toThrow("published prerelease");
    f.release.draft = false;
    f.release.prerelease = false;
    expect(f.prepare).toThrow("published prerelease");
    f.release.prerelease = true;
    f.movePreview();
    expect(f.prepare).toThrow("recorded source do not agree");
    f.lightweight();
    expect(() => resolvePreview(REPOSITORY, PREVIEW, f.run)).toThrow("annotated");
    expect(() => resolvePreview(REPOSITORY, "main", f.run)).toThrow("select a");
  });

  test("rejects reuse of a stable version and accepts an intentional minor release", () => {
    const f = fixture();
    f.stable.tag_name = "v2.12.0";
    expect(f.prepare).toThrow("newer than v2.12.0");
    f.stable.tag_name = "v2.11.0";
    const result = preparePromotion({ repository: REPOSITORY, preview: PREVIEW, version: "2.12.0", controls: f.controls, notes: NOTES, date: "2026-10-17" }, f.run);
    expect(result.promotion.version).toBe("2.12.0");
  });

  test("a retry reuses the reserved tag and rejects different notes", () => {
    const f = fixture();
    const first = f.prepare();
    f.git("git", ["push", "origin", `${first.sha}:refs/tags/v2.11.1`]);
    expect(f.prepare()).toMatchObject({ sha: first.sha, existing: true });
    expect(() => preparePromotion({
      repository: REPOSITORY, preview: PREVIEW, version: "2.11.1", controls: f.controls,
      notes: `${NOTES}\n- Different decision.`, date: "2026-10-18",
    }, f.run)).toThrow("different promotion");
    f.stable.tag_name = "v2.12.0";
    expect(f.prepare).toThrow("newer than v2.12.0");
  });

  test("a published promotion is recognized without scheduling another build", () => {
    const f = fixture();
    const first = f.prepare();
    f.git("git", ["push", "origin", `${first.sha}:refs/tags/v2.11.1`]);
    f.stable.tag_name = "v2.11.1";
    expect(f.prepare()).toMatchObject({ sha: first.sha, existing: true, published: true });
  });

  test("a release commit cannot hide the selected preview's warnings", () => {
    const f = fixture();
    const { sha, promotion } = f.prepare();
    f.git("git", ["checkout", "--detach", sha]);
    f.put(PROMOTION_FILE, `${JSON.stringify({ ...promotion, warnings: [] }, null, 2)}\n`);
    f.git("git", ["add", PROMOTION_FILE]);
    f.git("git", ["commit", "--amend", "--no-edit"]);
    f.tag(f.git("git", ["rev-parse", "HEAD"]).trim());
    expect(() => verifyPromotion("v2.11.1", REPOSITORY, f.run)).toThrow("warnings do not match");
  });

  test.each(["core/product.txt", "README.md", ".github/workflows/release.yml"])("rejects extra or altered content in %s", (path) => {
    const f = fixture();
    const { sha } = f.prepare();
    f.git("git", ["checkout", "--detach", sha]);
    f.put(path, "unexpected change\n");
    f.git("git", ["add", path]);
    f.git("git", ["commit", "--amend", "--no-edit"]);
    f.tag(f.git("git", ["rev-parse", "HEAD"]).trim());
    expect(() => verifyPromotion("v2.11.1", REPOSITORY, f.run)).toThrow(/outside release|unexpected release change/);
  });

  test("rejects a second release commit even when only metadata changed", () => {
    const f = fixture();
    const { sha } = f.prepare();
    f.git("git", ["checkout", "--detach", sha]);
    f.put("README.md", "another metadata commit\n");
    f.tag(f.commit("extra parent"));
    expect(() => verifyPromotion("v2.11.1", REPOSITORY, f.run)).toThrow("exactly the preview source");
  });

  test("rejects a source or controls commit outside main", () => {
    const f = fixture();
    f.git("git", ["checkout", "--detach", f.source]);
    f.put("outside.txt", "unreviewed\n");
    const outside = f.commit("not on main");
    expect(() => preparePromotion({
      repository: REPOSITORY, preview: PREVIEW, version: "2.11.1", controls: outside, notes: NOTES, date: "2026-10-17",
    }, f.run)).toThrow("merge-base");
  });

  test("a main metadata branch preserves later product and README changes", () => {
    const f = fixture();
    const { sha } = f.prepare();
    f.tag(sha);
    expect(syncMetadata("v2.11.1", REPOSITORY, f.run)).toContain("release-metadata/v2.11.1");
    f.git("git", ["fetch", "origin", "release-metadata/v2.11.1"]);
    expect(f.git("git", ["show", "FETCH_HEAD:core/product.txt"])).toBe("later main implementation\n");
    expect(f.git("git", ["show", "FETCH_HEAD:README.md"])).toContain("Later main readme");
    const paths = f.git("git", ["diff", "--name-only", f.controls, "FETCH_HEAD"]).trim().split("\n").sort();
    expect(paths).toEqual(["CHANGELOG.md", "README.md", "core/tools/aidlc-version.ts"]);
    expect(syncMetadata("v2.11.1", REPOSITORY, f.run)).toContain("release-metadata/v2.11.1");
  });

  test("main metadata synchronization never downgrades a newer version", () => {
    const f = fixture();
    const { sha } = f.prepare();
    f.tag(sha);
    f.put("core/tools/aidlc-version.ts", 'export const AIDLC_VERSION = "2.12.0";\n');
    f.commit("main version advanced");
    f.git("git", ["push", "origin", "main"]);
    expect(syncMetadata("v2.11.1", REPOSITORY, f.run)).toBeNull();
  });

  test("an existing metadata branch cannot smuggle unrelated product changes into its PR", () => {
    const f = fixture();
    f.tag(f.prepare().sha);
    f.put("core/product.txt", "unexpected metadata branch change\n");
    const unrelated = f.commit("unrelated");
    f.git("git", ["push", "origin", `${unrelated}:refs/heads/release-metadata/v2.11.1`]);
    expect(() => syncMetadata("v2.11.1", REPOSITORY, f.run)).toThrow("unrelated changes");
  });

  test("notes must carry compatibility and cannot add a second release entry", () => {
    expect(validateNotes(NOTES.replaceAll("\n", "\r\n"))).toBe(NOTES);
    expect(() => validateNotes("just release it")).toThrow("Compatibility");
    expect(() => validateNotes(`${NOTES}\n## [2.99.0] - 2026-10-17`)).toThrow("release headings");
    expect(() => validateNotes(`${NOTES}\n- Breaking for scripts: removed flag`)).toThrow("matching Compatibility");
    expect(() => validateNotes(`${NOTES}\n- https://github.com/owner/repo`)).toThrow("repository URLs");
  });

  test("star bullets can be promoted and preserve the same compatibility rules as dash bullets", () => {
    const f = fixture();
    const notes = NOTES.replace("\n- ", "\n* ");
    expect(validateNotes(notes)).toBe(notes);
    const { promotion } = preparePromotion({
      repository: REPOSITORY, preview: PREVIEW, version: "2.11.1",
      controls: f.controls, notes, date: "2026-10-17",
    }, f.run);
    expect(promotionNotes(promotion)).toContain("\n* Keep");
    expect(() => validateNotes(`${notes}\n* Breaking for scripts: removed flag`)).toThrow("matching Compatibility");
  });

  test("metadata keeps every previous changelog entry and rejects duplicate versions", () => {
    const f = fixture();
    const files = {
      "core/tools/aidlc-version.ts": readFileSync(join(f.root, "core/tools/aidlc-version.ts"), "utf8"),
      "README.md": readFileSync(join(f.root, "README.md"), "utf8"),
      "CHANGELOG.md": readFileSync(join(f.root, "CHANGELOG.md"), "utf8"),
    };
    const updated = metadataFiles(files, "2.11.1", "2026-10-17", NOTES);
    expect(updated["CHANGELOG.md"]).toEndWith(files["CHANGELOG.md"].slice("# Changelog\n\n".length));
    expect(() => metadataFiles({ ...files, "CHANGELOG.md": updated["CHANGELOG.md"] }, "2.11.1", "2026-10-17", NOTES)).toThrow("duplicate");
  });

  test("promotion records remain in Git, without changing the installed runtime's manifest contract", () => {
    const f = fixture();
    const { sha, promotion } = f.prepare();
    expect(JSON.parse(f.git("git", ["show", `${sha}:${PROMOTION_FILE}`]))).toEqual(promotion);
  });
});

describe("promotion workflow boundaries", () => {
  type Job = { uses?: string; needs?: string[] | string; permissions?: Record<string, string>; steps?: Array<{ run?: string; with?: Record<string, string> }> };
  const release = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/release.yml"), "utf8")) as { on: Record<string, unknown>; jobs: Record<string, Job> };
  test.each([
    [{ PREVIEW, VERSION: "", NOTES: "" }, ["version", "notes"]],
    [{ PREVIEW: "", VERSION: "2.11.1", NOTES }, ["preview"]],
  ])("partial promotion inputs explain how to recover before doing any work", (inputs, missing) => {
    const workflow = Bun.YAML.parse(readFileSync(join(REPO_ROOT, ".github/workflows/promote-release.yml"), "utf8")) as { jobs: Record<string, Job> };
    const step = workflow.jobs.prepare.steps?.find((step) => step.run?.includes("release-promotion.ts prepare"));
    expect(step?.run).toBeDefined();
    const result = spawnSync("bash", ["-c", step!.run!], {
      cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, ...inputs },
    });
    expect(result.status).toBe(1);
    for (const name of missing) expect(result.stderr).toContain(name);
    expect(result.stderr).toContain("Leave all inputs empty to list previews");
    expect(result.stderr).not.toContain("unbound variable");
  });
  test("does not schedule CI or Full Suite; publication still requires lifecycle and upgrade checks", () => {
    expect(release.on).toHaveProperty("workflow_dispatch");
    expect(Object.values(release.jobs).some((job) => job.uses?.endsWith("full-suite.yml"))).toBe(false);
    expect(release.jobs.publish.needs).toEqual(["validate", "musl-smoke", "windows-lifecycle", "unix-lifecycle", "update-from-previous"]);
    expect(release.jobs["update-from-previous"].steps?.[0].with?.ref).toBe(`\${{ needs.validate.outputs.controls }}`);
    expect(release.jobs.publish.permissions).toEqual({ contents: "read", "id-token": "write", attestations: "write" });
    expect(release.jobs["sync-metadata"].needs).toEqual(["validate", "release"]);
  });
});
