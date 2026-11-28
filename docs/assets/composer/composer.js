// Interactive composer: renders the form, the stage grid and the generated start command
// into <div id="aidlc-composer"> on docs/guide/05-1-interactive-composer.md.
// All rules live in composer-logic.js; this file only draws and listens.
// Loaded on every page (zensical.toml extra_javascript) and does nothing on a
// page without the mount point.

import {
  buildCommand,
  defaultReview,
  defaultTestStrategy,
  effectiveReview,
  effectiveTestStrategy,
  findScope,
  lostInputs,
  planChanges,
  planSummary,
  scopeDefaults,
} from "./composer-logic.js";

const DATA_URL = new URL("composer-data.json", import.meta.url);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === "text") node.textContent = value;
    else if (name === "class") node.className = value;
    else node.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function select(id, options, value, onChange) {
  const node = el("select", { id });
  for (const option of options) {
    node.append(el("option", { value: option.value, text: option.label, selected: option.value === value }));
  }
  node.addEventListener("change", () => onChange(node.value));
  return node;
}

function field(label, control, hint) {
  return el("div", { class: "aidlc-composer__field" }, [
    el("label", { for: control.id, text: label }),
    control,
    hint ? el("span", { class: "aidlc-composer__hint", text: hint }) : null,
  ]);
}

function mount(root, data) {
  let state = scopeDefaults(data, data.scopes.some((s) => s.name === "feature") ? "feature" : data.scopes[0].name);
  const stageName = new Map(data.stages.map((stage) => [stage.slug, `${stage.number} ${stage.name}`]));

  const form = el("div", { class: "aidlc-composer__form" });
  const stagesBox = el("div", { class: "aidlc-composer__stages" });
  const output = el("div", { class: "aidlc-composer__output" });
  root.replaceChildren(form, stagesBox, output);

  function update(patch) {
    state = { ...state, ...patch };
    render();
  }

  function renderForm() {
    const scope = findScope(data, state.scope);
    const scopeSelect = select(
      "aidlc-composer-scope",
      data.scopes.map((s) => ({
        value: s.name,
        label: `${s.name} (${Object.values(s.stages).filter((a) => a === "EXECUTE").length} stages)`,
      })),
      state.scope,
      (value) => {
        const description = state.description;
        state = { ...scopeDefaults(data, value), description };
        render();
      },
    );

    const project = select(
      "aidlc-composer-project",
      [
        { value: "detect", label: "Let AI-DLC scan the folder" },
        { value: "greenfield", label: "New project" },
        { value: "brownfield", label: "Existing code" },
      ],
      state.projectType,
      (value) => update({ projectType: value }),
    );

    const words = (list, fallback) =>
      list.map((value) => ({ value, label: value === fallback ? `${capitalize(value)} (scope default)` : capitalize(value) }));

    const guard = select("aidlc-composer-guard", words(data.flags.guardPolicy, scope.guardPolicy), state.guardPolicy,
      (value) => update({ guardPolicy: value }));
    const depth = select("aidlc-composer-depth", words(data.flags.depth, scope.depth), state.depth,
      (value) => update({ depth: value }));
    const testDefault = defaultTestStrategy(data, state);
    const testStrategy = select("aidlc-composer-tests", words(data.flags.testStrategy, testDefault),
      effectiveTestStrategy(data, state),
      (value) => update({ testStrategy: value === defaultTestStrategy(data, state) ? null : value }));
    const reviewDefault = defaultReview(data, state);
    const review = select(
      "aidlc-composer-review",
      data.flags.review.map((value) => ({
        value,
        label: `${value === "adversarial" ? "Adversarial (as each stage declares)" : capitalize(value)}${value === reviewDefault ? " (scope default)" : ""}`,
      })),
      effectiveReview(data, state),
      (value) => update({ review: value === defaultReview(data, state) ? null : value }),
    );

    const switches = el("fieldset", { class: "aidlc-composer__switches" }, [el("legend", { text: "Switches" })]);
    for (const { key, label } of data.flags.ceremony) {
      const id = `aidlc-composer-${key}`;
      const box = el("input", { type: "checkbox", id, checked: state.ceremony[key] === "on" });
      box.addEventListener("change", () => update({ ceremony: { ...state.ceremony, [key]: box.checked ? "on" : "off" } }));
      const changed = state.ceremony[key] !== scope.ceremony[key];
      switches.append(el("label", { for: id, class: changed ? "is-changed" : undefined }, [box, ` ${label}`]));
    }

    const description = el("input", {
      type: "text",
      id: "aidlc-composer-description",
      placeholder: "What to build, e.g. Add CSV export to the reports page",
      value: state.description,
    });
    description.addEventListener("input", () => {
      state = { ...state, description: description.value };
      renderOutput();
    });

    const reset = el("button", { type: "button", class: "md-button", text: "Reset to the scope defaults" });
    reset.addEventListener("click", () => {
      const keep = state.description;
      state = { ...scopeDefaults(data, state.scope), description: keep };
      render();
    });

    form.replaceChildren(
      el("div", { class: "aidlc-composer__grid" }, [
        field("Scope", scopeSelect, scope.description),
        field("Project", project, scope.existingCode ? "This scope is meant for existing code." : undefined),
        field("Guard Policy", guard),
        field("Depth", depth),
        field("Test strategy", testStrategy, state.testStrategy === null && !scope.testStrategy ? "Follows depth." : undefined),
        field("Stage reviews", review),
      ]),
      switches,
      field("What to build", description),
      reset,
    );
  }

  function renderStages() {
    const scope = findScope(data, state.scope);
    const children = [
      el("h3", { text: "Customize stages" }),
      el("p", {
        class: "aidlc-composer__hint",
        text:
          "A ticked box runs the stage. Clearing a stage the scope runs adds it to --skip; ticking one it does not run adds it to --add. " +
          "Initialization stages always run.",
      }),
    ];
    for (const phase of data.phases) {
      const box = el("fieldset", { class: "aidlc-composer__phase" }, [el("legend", { text: phase.label })]);
      for (const stage of data.stages.filter((s) => s.phase === phase.slug)) {
        const id = `aidlc-composer-stage-${stage.slug}`;
        const locked = phase.slug === "initialization";
        const base = scope.stages[stage.slug] === "EXECUTE";
        const input = el("input", { type: "checkbox", id, checked: state.grid[stage.slug], disabled: locked });
        input.addEventListener("change", () => update({ grid: { ...state.grid, [stage.slug]: input.checked } }));
        const changed = !locked && base !== state.grid[stage.slug];
        box.append(el("label", { for: id, class: changed ? "is-changed" : undefined, title: stage.slug }, [
          input,
          ` ${stage.number} ${stage.name}`,
          changed ? el("span", { class: "aidlc-composer__tag", text: base ? "skip" : "add" }) : null,
        ]));
      }
      children.push(box);
    }
    // Puts back only the scope's stages; the settings above stay as they are.
    const reset = el("button", { type: "button", class: "md-button", text: "Reset the stages to the scope defaults" });
    reset.addEventListener("click", () => update({ grid: scopeDefaults(data, state.scope).grid }));
    children.push(reset);
    stagesBox.replaceChildren(...children);
  }

  function renderOutput() {
    const command = buildCommand(data, state);
    const summary = planSummary(data, state);
    const { skip, add } = planChanges(data, state);
    const scope = findScope(data, state.scope);

    const code = el("code", { text: command });
    const copy = el("button", { type: "button", class: "md-button md-button--primary", text: "Copy" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(command);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Select and copy";
      }
      setTimeout(() => { copy.textContent = "Copy"; }, 1500);
    });

    const stats = el("ul", { class: "aidlc-composer__stats" }, [
      el("li", { text: `${summary.execute} of ${summary.total} stages run` }),
      el("li", { text: `${summary.gates} approval gates` }),
      el("li", {
        text: `${summary.reviews.adversarial + summary.reviews.advisory} stage reviews` +
          ` (${summary.reviews.adversarial} adversarial, ${summary.reviews.advisory} advisory)`,
      }),
      el("li", { text: `${skip.length} skipped, ${add.length} added` }),
    ]);

    const notes = [];
    const re = "reverse-engineering";
    if (state.grid[re] && state.projectType === "detect") {
      notes.push("If the folder holds no code yet, Reverse Engineering is skipped when the work is created, so one stage fewer runs.");
    } else if (state.grid[re] && state.projectType === "greenfield") {
      notes.push("On a new project Reverse Engineering is skipped when the work is created; the counts leave it out.");
    }
    if (state.projectType === "greenfield" && scope.existingCode) {
      notes.push(`The ${scope.name} scope is meant for existing code.`);
    }

    const lost = lostInputs(data, state);
    const lostBox = el("div", { class: "aidlc-composer__lost" }, [el("h4", { text: "Missing inputs" })]);
    if (skip.length === 0 && add.length === 0) {
      lostBox.append(el("p", {
        class: "aidlc-composer__hint",
        text: "Skip or add a stage to see whether a later stage loses something it needs from an earlier one.",
      }));
    } else if (lost.length === 0) {
      lostBox.append(el("p", { text: "Every stage that runs still gets what it needs from earlier stages." }));
    } else {
      const list = el("ul");
      for (const gap of lost) {
        const skipped = gap.producers.filter((slug) => skip.includes(slug));
        const from = gap.producers.length === 0
          ? ", which no stage produces"
          : skipped.length > 0
            ? ` from ${skipped.map((slug) => stageName.get(slug)).join(" or ")}, which you skipped`
            : ` from ${gap.producers.map((slug) => stageName.get(slug)).join(" or ")}, which this scope does not run`;
        list.append(el("li", {}, [
          el("strong", { text: stageName.get(gap.stage) }),
          " needs ",
          el("code", { text: gap.artifact }),
          `${from}.`,
        ]));
      }
      lostBox.append(
        list,
        el("p", {
          class: "aidlc-composer__hint",
          text: "Tick that stage to keep its output, or go ahead without it: the later stage then works from what there is.",
        }),
      );
    }

    output.replaceChildren(
      el("h3", { text: "How to start it" }),
      el("div", { class: "aidlc-composer__command" }, [el("pre", {}, [code]), copy]),
      stats,
      ...notes.map((note) => el("p", { class: "aidlc-composer__hint", text: note })),
      lostBox,
    );
  }

  function render() {
    renderForm();
    renderStages();
    renderOutput();
  }

  render();
}

async function start() {
  const root = document.getElementById("aidlc-composer");
  if (!root) return;
  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    root.dataset.version = data.version;
    mount(root, data);
  } catch (err) {
    root.replaceChildren(el("p", {
      class: "admonition warning",
      text: `The composer data could not be loaded (${err.message}). ` +
        "In a local preview, run `bun scripts/docs-composer-data.ts` first.",
    }));
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
