import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IntentCard } from "../ui/src/home/IntentCard";
import { summarize } from "../../core/command-center/server/model/home";
import { buildIntent } from "../../core/command-center/server/model/intent";
import { listIntents } from "../../core/command-center/server/parse/registry";
import { loadCatalog } from "../../core/command-center/server/parse/stage-graph";
import { makeWorkspace } from "./fixtures/make";

async function summary(now: Date) {
  const ws = await makeWorkspace({ directive: null }); const [ref] = await listIntents(ws); const cat = await loadCatalog(ws);
  return summarize(await buildIntent(ws, ref!, cat.stages, now));
}

test("Home card status decays from active to idle with the clock, like the intent view", async () => {
  const built = new Date("2026-08-13T23:21:00Z"); // 81 s after the last event: built as active
  const i = await summary(built);
  expect(i.liveness).toBe("active");
  expect(renderToStaticMarkup(<IntentCard i={i} now={built.getTime()} frozen={false} />)).toContain("active");
  const later = renderToStaticMarkup(<IntentCard i={i} now={built.getTime() + 10 * 60_000} frozen={false} />);
  expect(later).toContain("◌ idle");
  expect(later).not.toContain("live-dot");
});

test("Home card says when its workspace is polled instead of watched", async () => {
  const i = await summary(new Date("2026-08-14T12:00:00Z"));
  expect(renderToStaticMarkup(<IntentCard i={i} now={Date.parse("2026-08-14T12:00:00Z")} frozen={false} polling />)).toContain("polling every 10 s (file watching unavailable)");
  expect(renderToStaticMarkup(<IntentCard i={i} now={Date.parse("2026-08-14T12:00:00Z")} frozen={false} />)).not.toContain("polling every");
});
