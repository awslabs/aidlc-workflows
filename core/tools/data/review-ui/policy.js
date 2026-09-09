// The project's model policy, as one table both the composer's Agents
// slide-out and Settings render: each group with its agents and the effort it
// runs at, then the per-agent exceptions. `inherit` means the session's own
// effort - the composer chip / `/effort` - which pins never cap and are never
// capped by.
import { escapeHtml } from "./diff.js";

const GROUP_WHO = {
  deciding: "design, implementation, product, security, quality",
  reviewing: "product lead, architecture reviewer",
  "writing-up": "delivery, pipeline & deploy, operations",
};

export function effortCell(value) {
  if (!value || value === "inherit") return `<span class="policy-inherit" title="Runs at the session's effort - the Effort chip">inherits the session</span>`;
  return `<b>${escapeHtml(value)}</b>`;
}

export function policyTable(policy) {
  if (!policy) return `<table class="policy-table"><tbody><tr><td colspan="2"><small>No policy to show for this install.</small></td></tr></tbody></table>`;
  const groups = policy.groups.map((group) => `<tr data-group="${escapeHtml(group.id)}"><th><b>${escapeHtml(group.label)}</b><small>${escapeHtml(group.agents.length ? group.agents.join(", ") : GROUP_WHO[group.id] || "")}</small></th><td>${group.mixed ? `<b>${escapeHtml(group.effort)}</b>` : effortCell(group.effort)}</td></tr>`).join("");
  const exceptions = policy.exceptions.map((entry) => `<tr class="policy-exception" data-agent="${escapeHtml(entry.agent)}"><th><b>${escapeHtml(entry.agent)}</b><small>exception · ${escapeHtml(entry.group)}</small></th><td>${effortCell(entry.effort)}${entry.model ? `<small>${escapeHtml(entry.model)}</small>` : ""}</td></tr>`).join("");
  return `<table class="policy-table"><tbody>${groups}${exceptions}</tbody></table>${policy.honesty ? `<p class="policy-note">${escapeHtml(policy.honesty)}</p>` : ""}`;
}
