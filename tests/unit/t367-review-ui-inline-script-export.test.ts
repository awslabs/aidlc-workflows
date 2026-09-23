import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { selfContainedMarkdownExport } from "../../core/tools/aidlc-review-ui-render.ts";

describe("t367 review UI inline script export", () => {
  test("embeds readable offline JavaScript and escapes HTML script-data sequences", () => {
    const marker = "aidlc-offline-mermaid-unique-marker";
    const mermaidScript = [
      `globalThis.marker = "${marker}";`,
      'globalThis.payloads = ["</script>", "</ScRiPt>", "<!--"];',
      "globalThis.mermaid = { initialize(options) { globalThis.startOnLoad = options.startOnLoad; } };",
    ].join("\n");
    const html = selfContainedMarkdownExport(
      "# Diagram\n\n```mermaid\ngraph TD; A-->B\n```\n",
      mermaidScript,
    );

    expect(html).not.toContain("eval(");
    expect(html).not.toContain("atob(");
    expect(html).toContain(marker);
    expect(html).not.toMatch(/<script\b[^>]*\bsrc\s*=/i);
    expect(html).toContain('"\\x3C/script>"');
    expect(html).toContain('"\\x3C/ScRiPt>"');
    expect(html).toContain('"\\x3C!--"');
    expect(html).not.toContain("<!--");
    expect(html.match(/<\/script\s*>/gi)).toHaveLength(2);
    expect(html).toContain('<pre class="mermaid">graph TD; A--&gt;B</pre>');

    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
    expect(scripts).toHaveLength(2);
    const context: Record<string, unknown> = {};
    for (const [, source] of scripts) runInNewContext(source, context);
    expect(context).toMatchObject({
      marker,
      payloads: ["</script>", "</ScRiPt>", "<!--"],
      startOnLoad: true,
    });
  });

  test("omits script tags when no Mermaid source is supplied", () => {
    const html = selfContainedMarkdownExport("# Plain Markdown\n\nNo diagram.\n");

    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<\/script\s*>/i);
    expect(html).toContain('<h1 id="plain-markdown">Plain Markdown</h1>');
    expect(html).toContain("<p>No diagram.</p>");
  });
});
