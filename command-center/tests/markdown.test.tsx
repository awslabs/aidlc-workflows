import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../ui/src/lenses/markdown";

test("markdown preview escapes raw HTML and never emits links or script tags", () => {
  const html = renderToStaticMarkup(<Markdown src={"# Title <img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) and **bold** `<b>code</b>`\n\n| a | b |\n|---|---|\n| <iframe> | [y](http://evil) |\n"} />);
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<iframe");
  expect(html).not.toContain("<a ");
  expect(html).not.toContain("href");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain("<b>bold</b>");
  expect(html).toContain("<code>&lt;b&gt;code&lt;/b&gt;</code>");
});
