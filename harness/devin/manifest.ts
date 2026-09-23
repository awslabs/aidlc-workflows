// harness/devin/manifest.ts — the Devin CLI distribution row.
//
// One core, N harnesses (dist-unified). This manifest tells scripts/package.ts
// how to project the harness-neutral core/ tree into dist/devin/.devin/:
//   - the harness directory token substitution ({{HARNESS_DIR}} → .devin)
//   - the per-dir map (core/<src> → <harnessDir>/<dst>); Devin renames nothing
//   - which authored files live in harness/devin/ and where they land
//
// Devin is a peer harness, not the identity transform: its prose carries the
// same {{HARNESS_DIR}} token as every other harness; the packager substitutes
// `.devin` here. Devin is authored-files-only like Claude (no emit()): every
// harness-specific surface (the stdin adapter shim, hooks.v1.json wiring,
// config.json permissions, mcp_config.json, the rules/aidlc.md auto-load stub,
// the orchestrator SKILL.md) is a hand-authored harnessFile copied verbatim
// (with token substitution on .md). The plugin projection is omitted so the
// packager derives the default `.devin-plugin` + `kind:"store"` (Devin's native
// plugin format).

import type { HarnessManifest } from "../../scripts/manifest-types.ts";
import onboardingFills from "./onboarding.fills.ts";

const DELEGATION_AGENTS = [
  "aidlc-composer-agent",
  "aidlc-developer-agent",
  "aidlc-architect-agent",
  "aidlc-product-lead-agent",
  "aidlc-architecture-reviewer-agent",
  "aidlc-product-agent",
  "aidlc-design-agent",
  "aidlc-delivery-agent",
  "aidlc-aws-platform-agent",
  "aidlc-compliance-agent",
  "aidlc-devsecops-agent",
  "aidlc-quality-agent",
  "aidlc-pipeline-deploy-agent",
  "aidlc-operations-agent",
] as const;

// The two review-only profiles keep only the tools a review needs: exec for
// the review brief's framework commands, write/edit for the review file, and
// the read/search tools (read, grep, glob). apply_patch, notebook tools,
// write_to_process (an untracked shell channel), get_output/kill_shell, and
// the mcp_* surface are withheld — the reviewer-scope hook binds the
// reviewer's reads to its unit, and a narrower grant shrinks what an
// unattributed call could reach.
const REVIEW_ONLY_AGENTS = new Set<string>([
  "aidlc-architecture-reviewer-agent",
  "aidlc-product-lead-agent",
]);

const DELEGATION_ALLOWED_TOOLS =
  "allowed-tools: [read, write, edit, apply_patch, notebook_read, notebook_edit, grep, glob, exec, get_output, write_to_process, kill_shell, web_search, webfetch, todo_write, request_scope, mcp_list_servers, mcp_list_tools, mcp_call_tool, mcp_read_resource]";
const REVIEW_ALLOWED_TOOLS =
  "allowed-tools: [read, write, edit, grep, glob, exec]";

const manifest: HarnessManifest = {
  name: "devin",
  productName: "Devin CLI",
  configNextStep: "start Devin CLI in this project, then run `/aidlc --doctor`",
  harnessDir: ".devin",
  orchestratorSkillPath: ".devin/skills/aidlc/SKILL.md",
  tierFlavor: "devin",
  rootIntegrations: [
    {
      path: ".gitignore",
      policy: "managed-block",
      marker: "gitignore",
      shared: "union",
      legacySignatures: {
        wholeFileHashes: [
          // The shared root .gitignore predates Devin: keep every variant any
          // sibling harness shipped recognizable on a Devin-managed project.
          "sha256:3da36b2d01551aeae2e366caa08be8cce0dbc9110e252445dcaa4e758e24a0b6",
          "sha256:4f1cd2e930bd37d2f5d715a06ea3fa1e2d39479fc662f0f0562116376132114b",
          "sha256:f2affb8b34499f057284852456cb8a24ae586b8e816595bf98346141f3516281",
          "sha256:d397e69ac701a663158ccb43fda3f0a23c86365f29419a8c9a5e3287a490370d",
          "sha256:87e4c1237816c477096f2291f1204885692bf39e487afb3d9f67cf7e9b2c84fb",
          "sha256:f919e4bac1790bd1a371d371af473ccbc644f3bb80e4569d190c9364fad771b3",
          "sha256:d2569b56aef154c3c04766ed3263947a2d8026c99546a3006775526641951db9",
          "sha256:f52e6097d36c2e5bc199a2529469a4c6e7c507f7960f94a0b2b46f9aeee60e56",
          "sha256:b4bf7694361e76aae9feabc5d985d09afb7863cf8458b0c9aaa73f20a589582f",
          "sha256:83449fdda4644b319cbea5dcbde11919722b5dd6761f4edb4caf0e0e53dc9c6b",
          "sha256:469dbf89f83865b58b2ae4c51dd2f2fe51fd80a9e2033bfb233688141d0cf632",
          "sha256:648f12cb08d05e7bdf97ad4e69e36b7d2b76687d047811d58d196623fd9191bf",
          "sha256:e82d7773f981dabccc1a0a8a31dad4feb26c2af4a65cc7d686bb2a0581ce0ecb",
        ],
      },
    },
    {
      path: "AGENTS.md",
      policy: "managed-block",
      marker: "agents",
      shared: "identical",
      legacySignatures: {
        wholeFileHashes: [
          // Devin shares the byte-identical neutral root file: the inventory is
          // the union of every variant the other sharing harnesses shipped, so
          // a project adopting Devin on top of any of them stays recognizable.
          "sha256:30a9f5f43d87cd29b63e75333b8ef6695f8f4e11909fd6af64e2b6cf0b8cb292",
          "sha256:47678f42e0233de9b0164eb4ec318a3ba3196074d6ec88f69aa7980bc1f2fd0d",
          "sha256:821b2149c7c6c2b6592eecd10623823fc5579fc4ae52f2ad272e00c93013d027",
          "sha256:83c6e5141646dc604c87d80622fc898761a69bd0c9caebb398441bce9f1d0727",
          "sha256:b3a07e9bb603fb0a2328004fc7cf2294afc670ec6f350a43de9c15d6e27aa04e",
          "sha256:bfc2adb83e00041750b1d19c9f3167cb7f5f5502a62af83a58d0a2828890febf",
          "sha256:d8afae6a0813f5298cf873a047664cf485308c6e0dad41dde53d8dcb27dd7769",
          "sha256:f1deb7dc72a78fe7d39c71ad2fe6c0f41248c03cde7fb36b7a478f5b9233881c",
          "sha256:f7c55e9917d3801f676fba066fdd78d8df2c36311e8d6e78068965fc7b4371fa",
          "sha256:457ff3626bf6ff4a0f6f1f7a44a1d2cbcd91490600e2332742dcf655da25b7f3",
          "sha256:9be9c5cc4a25e5b4c71b3ae35188e1a543504f19cbd5d0a20892777b0904800e",
          "sha256:bc41aca84970977673af3c0b8212a1f7a4d995a4b47fc7894b1c5b342e4a3601",
          "sha256:b3d4d0d178a01591629dbf79083b00e7a3ad42f59f79cbfc88d05b7615704a70",
          "sha256:d9be36630b49183203ae4d97946c243e3b8840202ee6f080c738e0f01343e33a",
          "sha256:cc3212fc7335018158882cbaa141ac6fd02cee53bbceb00bd185f416fa06ff8f",
          "sha256:412776ee4595c453511a911e06c7729285bb5338b30584f8570908b273e27296",
          "sha256:dd650e54fb2e645b6f30002f91f8f6f174fe34550295582f5b6a95356edaed77",
          "sha256:87563548299dd2a0c1fcd3cde480b612bd1ec767a2550dbc05a6a041a3d7f522",
          "sha256:c7843449d549d4226be39169a9c31bf89694cd0b0754cb1ee68bdf61759538ce",
          "sha256:4f7133cc1a9bb1243245c25c28fad57c3660b35e251ea36cea3aa2db431bf55f",
          "sha256:992307cc3fac05d81958851b2ca51db3723fea604c8d2636814ef9b2e9f7a848",
          "sha256:b886d5b375f9ebc33ef206c4f6ad20630a13eb83d0f5838e9f71f483c040f362",
          "sha256:c6796d512752c8f4aa927c9de3fb794e3432f62dd85b77fe3da1101d90aa5a0b",
          "sha256:cd7c66ba1bdd67af0be6203a1d8928efc01733ef196201003e914051d1309a28",
          "sha256:e01ac1caf52a59d25faf859a03cfb65b803853c99298bbcbc80ef565e7628de6",
          "sha256:e3de4a295f9b9404b40678c28c0773ae432ac8d4aeacc07613ecfcdfbb4c866b",
          "sha256:e85a5d7ce13b676282dc99572f89c81256f2dada50b1881f4c9641e61339f5a4",
          "sha256:67a57eddd94d613590d34ec2d0181398123d9e2d9f6382eb36c62233ce02b6f9",
          "sha256:3aea80a2afde8bb2a222b329bcfc2855b4207a53f7fbfbc3abbfb4aadbafc53b",
          "sha256:1abeb3cb19943bc1537c413dc45298c43a14ce7544444c88c13b53ea48a607a6",
          "sha256:ecb68f08789258e77c81488e98dd1632b607b567a2424311c4dcdc30ce3e768f",
          "sha256:9ad7daa07cbafe9f149311b679281eecd991d2ec77787fc7751226ea0622522b",
          "sha256:c8777a03505f11dcbb4fb339fef1a8072d9d2500ce401b69a06073b523ea2c67",
          "sha256:4d539288363565feb6cf1a8d2468d1aca4373d46d354936d89e609f9862b2b9f",
          "sha256:8159f54fcfe2a2ef807227cb12a3c83327e3851672ea47294812dde411f0de69",
          "sha256:8d59f353b5575abe6ee12e8abd5ac75f55461bd7307d677d64388c16690e5afa",
          "sha256:aef608b826a4993d47e3de98679a81abe4823c7c73556def4a339c5cb92999e7",
          "sha256:b58a882d1b56bbb5cdb9a3c356b1428eb8d2593f4a9ca22118b98ca7cd0bae9c",
          "sha256:c5d2188b046cd75d8cb7214f32faa85cbc1539cddda4a0fae9bfe8fad90c237c",
          "sha256:dead4d5ea47849f489e05baeae418d5d26efc6cd14dd2201351a474376f8efde",
          "sha256:990d80744904bfa3f9923b8a04bbb2e69b454154346915edca1e1a4ef7e31c07",
          "sha256:025c596b2f44b688a329d419b5cd39fd2ee2a6d6cae4e6491dc6cd0f663c04ea",
          "sha256:68be79dc053e88931557484ef37b7f63248cddcf02cb44db89c5bd2522980967",
          "sha256:6735312a6ece44f0ba65b949ede2a241669fa422db584dadb2a9ed57e4e43be7",
          "sha256:94f27a88ddba31149876da0609e0eb9a36ce153f52f27898579c846daec2ff59",
          "sha256:5f6f076a5a9d8a11e1078f568c9dee091f399d9999fae89e9dffa62d8697b797",
          "sha256:78c906200a55665f3a3ce410272c71d4bdcb5764174407da0f69d8ad6d143184",
          "sha256:2907b5293bfd8bd9d5f8b7a8025bfe23edd0ffcd31f925761916088517880936",
          "sha256:2ef8a8cd1b72e59d017013b8d261721b1c5dedb82499b44dc9a97be01b6a73cb",
          "sha256:eeabf9f9555124da3f5ad34eb3a26b9fcbf3e2ccd65610cb9f0182701cf3ef48",
          "sha256:d791057d6b667517197a450bc6ba633c36e148d62e09c90a8992d787c914a44f",
          "sha256:d86a61b7376772dcc7afdaefd63ce185f99d9c32d0e455668cf3b52f91a13d40",
          "sha256:db6e65ed85d6b47ca47d72b5a323ddc4dca76d021cce92591c1a28b26d9f237a",
          "sha256:c5b990429fe6dfa084d58fc592d1d22c1170cc35aa98f9cbb2c82b9924520eda",
          // The 2.9.0 neutral-skeleton variant (the Devin entry joined the
          // shared file).
          "sha256:6de1298dfa4c2b6916f66d372b844faf23481c8f258eedd595c1423dab8e106d",
        ],
      },
    },
  ],

  // core/<src> → <harnessDir>/<dst>. Devin keeps every core dir name as-is
  // (same projection as Claude). The method ("memory") is NO LONGER a core dir
  // projected into the harness tree — it relocated to the workspace-root
  // aidlc/spaces/default/memory/ (one hand-editable copy, emitted by the
  // packager's memory step), loaded by Devin via the .devin/rules/aidlc.md
  // auto-load stub (a harnessFile — Devin loads .devin/rules/*.md automatically,
  // no @-import needed).
  coreDirs: [
    { src: "tools", dst: "tools" },
    { src: "aidlc-common", dst: "aidlc-common" },
    { src: "knowledge", dst: "knowledge" },
    { src: "sensors", dst: "sensors" },
    { src: "scopes", dst: "scopes" },
    { src: "agents", dst: "agents" },
    { src: "hooks", dst: "hooks" },
    // The harness-neutral standalone skills ship in-tree under skills/.
    { src: "skills/aidlc-session-cost", dst: "skills/aidlc-session-cost" },
    { src: "skills/aidlc-replay", dst: "skills/aidlc-replay" },
    { src: "skills/aidlc-outcomes-pack", dst: "skills/aidlc-outcomes-pack" },
    { src: "skills/aidlc-knowledge", dst: "skills/aidlc-knowledge" },
  ],

  // Authored harness surfaces copied verbatim (with token substitution on .md)
  // from harness/devin/<src> → <harnessDir>/<dst>. The stdin adapter shim
  // re-wraps Devin's hook JSON onto the core hooks; hooks.v1.json wires Devin
  // events → adapter → core hooks; config.json holds Devin permissions;
  // mcp_config.json declares the MCP servers; rules/aidlc.md is the auto-loaded
  // method pointer; skills/aidlc/SKILL.md is the orchestrator.
  harnessFiles: [
    { src: "hooks/aidlc-devin-adapter.ts", dst: "hooks/aidlc-devin-adapter.ts" },
    { src: "hooks.v1.json", dst: "hooks.v1.json" },
    { src: "config.json", dst: "config.json" },
    { src: "mcp_config.json", dst: "mcp_config.json" },
    // The AIDLC method auto-load stub: .devin/rules/aidlc.md points at the
    // relocated method (aidlc/spaces/default/memory/*). Devin loads
    // .devin/rules/*.md into ambient context automatically (no @-import, unlike
    // Claude). The rules/ dir is no longer a core projection — this stub is the
    // only file in it.
    { src: "rules-aidlc.md", dst: "rules/aidlc.md" },
    { src: "skills/aidlc/SKILL.md", dst: "skills/aidlc/SKILL.md" },
    { src: "skills/aidlc/question-rendering.md", dst: "skills/aidlc/question-rendering.md" },
    // Project-root install files (beside .devin/, not inside it). A user copies
    // `dist/devin/` wholesale, so these ship at the dist root. Authored here
    // (not core/) because they are Devin-specific: the .gitignore names
    // `.devin/config.local.json` etc. projectRoot routes them to
    // dist/devin/<dst> and brings them under the --check drift guard
    // (checkHarness diffs every projectRoot file). dot-gitignore is the
    // authored name so it does not act as a live ignore inside harness/devin/.
    { src: "dot-gitignore", dst: ".gitignore", projectRoot: true },
  ],

  // The neutral onboarding doc (AGENTS.md) renders from
  // core/templates/onboarding.md — byte-identical to the other harnesses'
  // project-root files — while the native skeleton
  // (core/templates/onboarding-harness.md) renders with Devin's fills into
  // .devin/rules/aidlc-onboarding.md, an always-on Devin rule. Both go through
  // the standard {{HARNESS_DIR}} → .devin transform.
  onboarding: {
    dst: "AGENTS.md",
    projectRoot: true,
    harnessDst: "rules/aidlc-onboarding.md",
    fills: onboardingFills,
  },

  // Devin renames no core dir.
  rulesRename: null,

  // No emit() plugin: Devin's runners come from the shared runner-gen
  // composition and its compiled data from graph compile, both driven by the
  // packager. Every Devin-specific surface is an authored harnessFile. (Codex is
  // the only harness that ships an emit.ts today.)
  emit: null,

  // Devin-native runner frontmatter: generated stage/init/scope/composition
  // runners are user-only (triggers: [user]). Devin's skill loader activates
  // a skill only when its triggers frontmatter matches the invocation context;
  // without an explicit triggers line the runner would not be invocable via
  // its /aidlc-<stage> slash command. This is a Devin-only addition — the
  // shared runner-gen reads it from harness.json and injects it into every
  // generated runner SKILL.md.
  runnerFrontmatterAdditions: ["triggers: [user]"],

  // Devin-native standalone skill triggers: aidlc-knowledge and aidlc-outcomes-pack
  // are user-invocable skills that need an explicit triggers: [user] line for
  // Devin's skill loader. The read-only session skills (aidlc-replay,
  // aidlc-session-cost) already carry triggers in their authored frontmatter
  // via the user-invocable: true field which Devin maps to user triggers.
  frontmatterAdditions: [
    { file: "skills/aidlc-knowledge/SKILL.md", lines: ["triggers: [user]"] },
    { file: "skills/aidlc-outcomes-pack/SKILL.md", lines: ["triggers: [user]"] },
    ...DELEGATION_AGENTS.map((agent) => ({
      file: `agents/${agent}.md`,
      lines: [
        REVIEW_ONLY_AGENTS.has(agent)
          ? REVIEW_ALLOWED_TOOLS
          : DELEGATION_ALLOWED_TOOLS,
      ],
    })),
  ],

  // plugin omitted → the packager derives the default `.devin-plugin` +
  // kind:"store" projection (Devin's native plugin format), per manifest-types.
};

export default manifest;
