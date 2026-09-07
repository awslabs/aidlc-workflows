// Question rounds are a projection of the canonical questions file. The browser
// only writes an answers-NNN.json submission; the terminal remains the place
// where that submission is applied to the questions file.
import { api } from "./api.js";
import { store } from "./store.js";

const HTML_TAGS = new Set([
  "h2", "h3", "p", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td",
  "figure", "figcaption",
]);
const BLOCKED_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "template", "foreignobject",
]);
const SVG_TAGS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "defs", "marker", "title", "desc",
]);
const HTML_ATTRIBUTES = new Set([
  "class", "title", "role", "colspan", "rowspan", "scope", "width", "height",
  "data-aidlc-recommend",
]);
const SVG_ATTRIBUTES = new Set([
  "id", "class", "role", "viewbox", "preserveaspectratio", "width", "height", "x", "y",
  "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "transform",
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-dasharray", "stroke-opacity", "opacity", "font-size", "font-weight", "text-anchor",
  "dominant-baseline", "marker-start", "marker-mid", "marker-end", "markerwidth",
  "markerheight", "refx", "refy", "orient", "markerunits", "href", "xlink:href",
]);
const SVG_ATTRIBUTE_NAMES = new Map([
  ["viewbox", "viewBox"],
  ["preserveaspectratio", "preserveAspectRatio"],
  ["markerwidth", "markerWidth"],
  ["markerheight", "markerHeight"],
  ["refx", "refX"],
  ["refy", "refY"],
  ["markerunits", "markerUnits"],
]);
const SVG_NAMESPACE = ["http:", "", "www.w3.org", "2000", "svg"].join("/");
const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const DRAFT_PREFIX = "aidlc-review-answers:";

let elements;
let current = null;
let loadGeneration = 0;
// Whether the published round already has a submission is the daemon's fact
// (`state.questions.submitted`); this tab keeps no memory of what it sent.
function submitted() {
  return Boolean(store.state?.questions?.submitted);
}
const SUBMITTED_MESSAGE = "Answers sent - the agent is picking them up now.";
let saving = false;

export function init() {
  elements = {
    view: document.getElementById("questions-view"),
    form: document.getElementById("questions-form"),
    title: document.getElementById("questions-title"),
    content: document.getElementById("questions-content"),
    banner: document.getElementById("questions-banner"),
    save: document.getElementById("save-answers-button"),
    guide: document.getElementById("guide-content"),
  };
  if (!elements.view || !elements.form || !elements.content) return;

  elements.save.hidden = true;
  elements.guide.hidden = true;
  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    saveAnswers();
  });
  elements.form.addEventListener("change", handleFormChange);
  elements.form.addEventListener("input", handleFormInput);
  elements.form.addEventListener("focusin", handleFormFocus);

  store.on("view", showCurrentView);
  store.on("refresh", loadQuestions);
  store.on("workflow", renderCurrent);
  store.on("save-answers", saveAnswers);
  showCurrentView();
}

function showCurrentView() {
  const showing = store.view?.kind === "questions";
  elements.view.hidden = !showing;
  if (!showing) {
    loadGeneration++;
    return;
  }
  loadQuestions();
}

async function loadQuestions() {
  if (store.view?.kind !== "questions") return;
  const pointer = store.state?.questions;
  if (!pointer?.file) {
    current = null;
    renderPlaceholder(
      "Questions are not available in the browser yet. You can answer this round from the terminal.",
    );
    return;
  }

  // Not ready: the agent is still writing the explainer (or the questions
  // file is malformed and being fixed). No form, no Save — a submission now
  // would land before the terminal is holding for it.
  if (pointer.preparing) {
    current = null;
    if (store.questionsState !== "preparing") store.set({ questionsState: "preparing" });
    renderPlaceholder("Preparing your questions — the agent is writing the explainer and its recommendations. This page updates on its own.", true);
    return;
  }

  const generation = ++loadGeneration;
  renderPlaceholder("Loading the question round…", true);
  const guideRequest = pointer.guide
    ? api.text("/api/raw", { path: pointer.guide })
      .then(parseGuide)
      .catch((error) => {
        console.warn("[review-ui] question guide unavailable", error);
        return new Map();
      })
    : Promise.resolve(new Map());

  try {
    const [questions, guide] = await Promise.all([
      api.get("/api/questions", { path: pointer.file }),
      guideRequest,
    ]);
    if (generation !== loadGeneration || store.view?.kind !== "questions") return;
    current = { questions, guide, pointer };
    renderCurrent();
  } catch (error) {
    if (generation !== loadGeneration) return;
    current = null;
    console.warn("[review-ui] question round unavailable", error);
    renderPlaceholder(
      "This question round is not available in the browser right now. You can still answer it from the terminal.",
    );
  }
}

function renderPlaceholder(message, loading = false) {
  elements.view.classList.remove("answered", "submitted");
  elements.title.textContent = "Questions";
  const placeholder = document.createElement("p");
  placeholder.className = `questions-placeholder${loading ? " loading" : ""}`;
  placeholder.textContent = message;
  elements.content.replaceChildren(placeholder);
  clearBanner();
}

function renderCurrent() {
  if (!current || store.view?.kind !== "questions") return;
  const { questions, guide } = current;
  const visibleQuestions = questions.questions.filter((question) => !question.confirmation);
  const confirmation = questions.questions.find((question) => question.confirmation);
  const answered = visibleQuestions.length > 0 && visibleQuestions.every((question) => question.answer !== null);
  const questionsState = answered ? "answered" : submitted() ? "submitted" : "live";
  if (store.questionsState !== questionsState) store.set({ questionsState });

  elements.view.classList.toggle("answered", answered);
  elements.view.classList.toggle("submitted", submitted());
  elements.title.textContent = "Questions";
  const column = document.createElement("section");
  column.className = "qcol";
  column.append(renderIntro(visibleQuestions.length, answered));

  const draft = answered ? null : restoreDraft(questions.sha256);
  visibleQuestions.forEach((question, index) => {
    column.append(renderQuestion(question, index, visibleQuestions.length, guide.get(question.id), draft, answered));
  });
  if (confirmation && confirmation.answer === null) {
    const note = document.createElement("p");
    note.className = "confirmation-note";
    note.textContent = "The confirmation happens in the terminal after your answers are applied.";
    column.append(note);
  }

  elements.content.replaceChildren(column);
  elements.guide.textContent = guide.size ? "Explainers are shown with each question." : "No explainer yet";
  elements.guide.hidden = true;
  if (answered) {
    clearBanner();
  } else if (submitted()) {
    showBanner(SUBMITTED_MESSAGE, "success");
    setFormLocked(true);
  } else {
    clearBanner();
  }
}

function renderIntro(count, answered) {
  const intro = document.createElement("div");
  intro.className = "qintro";
  const heading = document.createElement("h1");
  const { stage, artifact } = questionContext();
  heading.textContent = `${stage} · questions before the ${artifact}`;
  const lead = document.createElement("p");
  if (answered) {
    lead.textContent = "The reasoning stays with the answers so anyone can see why each decision was made. To change one, reopen the round from the terminal.";
  } else {
    const amount = NUMBER_WORDS[count] || String(count);
    lead.textContent = `${amount} decisions in this round. Read the reasoning, then answer — recommendations are pre-selected.`;
  }
  intro.append(heading, lead);
  return intro;
}

function questionContext() {
  const slug = current?.pointer?.stage || store.view?.stage || "questions";
  const stages = (store.workflow?.phases || []).flatMap((phase) => phase.stages || []);
  const stage = stages.find((candidate) => candidate.slug === slug);
  const stageName = stage?.name || humanize(slug);
  const artifacts = stage?.artifacts || store.state?.manifest?.artifacts || [];
  const produced = artifacts.find((artifact) => artifact.produces && artifact.kind !== "machine")
    || artifacts.find((artifact) => artifact.produces)
    || artifacts.find((artifact) => !/questions|memory/i.test(artifact.name || ""));
  let artifactName = produced?.name;
  if (!artifactName) {
    artifactName = basename(current?.questions?.path || "questions.md")
      .replace(/-questions\.(?:md|markdown)$/i, "")
      .replace(/-analysis$/i, "");
  }
  return {
    stage: stageName,
    artifact: humanize(String(artifactName || "artifact").replace(/\.[^.]+$/, "")).toLowerCase(),
  };
}

function renderQuestion(question, index, count, guide, draft, answered) {
  const recommendation = recommendedLetter(question, guide);
  const recorded = parseRecordedAnswer(question.answer);
  const draftAnswer = draft?.answers?.[question.id];
  let labels;
  let other;
  let note;
  if (answered) {
    labels = recorded.labels;
    other = recorded.other;
  } else if (draftAnswer && Array.isArray(draftAnswer.labels)) {
    labels = draftAnswer.labels.filter((letter) => question.options.some((option) => option.letter === letter));
    other = typeof draftAnswer.other === "string" ? draftAnswer.other : "";
    note = typeof draftAnswer.note === "string" ? draftAnswer.note : "";
  } else if (question.answer !== null) {
    labels = recorded.labels;
    other = recorded.other;
    note = question.note || "";
  } else {
    labels = recommendation ? [recommendation] : [];
    other = "";
    note = "";
  }

  const block = document.createElement("section");
  block.className = "qblock";
  block.dataset.questionId = question.id;
  const number = document.createElement("p");
  number.className = "qnum";
  number.textContent = `Question ${index + 1} of ${count}`;
  const title = document.createElement("h2");
  title.textContent = question.title.replace(/^Q\d+\.\s*/i, "");
  const explain = renderExplainer(question, guide, recommendation);
  const card = document.createElement("article");
  card.className = "qcard";
  const cardTitle = document.createElement("h3");
  cardTitle.textContent = "Your answer";
  card.append(cardTitle);

  const onRecommendation = answered
    && recommendation !== null
    && labels.length === 1
    && labels[0] === recommendation;
  if (answered) {
    const answerLine = document.createElement("p");
    answerLine.className = "ans-line";
    const status = document.createElement("b");
    status.textContent = "✓ Answered";
    answerLine.append(status, document.createTextNode(onRecommendation ? " · on the recommendation" : " · chose another option"));
    card.append(answerLine);
  }

  const options = document.createElement("div");
  options.className = "options";
  for (const option of question.options) {
    if (!option.letter) continue;
    const chosen = labels.includes(option.letter);
    options.append(renderOption(question, option, recommendation, chosen, other, answered));
  }
  card.append(options);
  if (!answered) card.append(renderNote(question.id, note || ""));
  block.append(number, title, explain, card);
  return block;
}

function renderExplainer(question, guide, recommendation) {
  const explain = document.createElement("div");
  explain.className = "explain";
  if (!guide?.content?.childNodes.length) {
    appendPrompt(explain, question.prompt);
    return explain;
  }

  const children = [...guide.content.childNodes];
  const firstElement = children.find((node) => node.nodeType === Node.ELEMENT_NODE);
  for (const child of children) {
    if (child === firstElement && child.localName === "h2") continue;
    explain.append(child.cloneNode(true));
  }
  decorateGuide(explain);
  const optionText = question.options.find((option) => option.letter === recommendation)?.text || "";
  highlightRecommendation(explain, optionText, guide.recommendationText);
  return explain;
}

function appendPrompt(container, prompt) {
  for (const paragraph of String(prompt || "").split(/\n\s*\n/).filter(Boolean)) {
    const text = document.createElement("p");
    text.innerHTML = inlineMarkdown(paragraph);
    container.append(text);
  }
}

function renderOption(question, option, recommendation, chosen, other, answered) {
  const recommended = option.letter === recommendation;
  const label = document.createElement("label");
  label.className = "option";
  label.dataset.optionLetter = option.letter;
  if (recommended) label.classList.add("recommended");
  if (chosen && answered) label.classList.add("chosen");

  const choice = document.createElement("input");
  choice.type = question.multi ? "checkbox" : "radio";
  choice.name = `answer-${question.id}`;
  choice.value = option.letter;
  choice.dataset.choice = "";
  choice.checked = chosen;
  choice.disabled = answered;
  const text = document.createElement("span");
  text.className = "option-text";
  text.innerHTML = inlineMarkdown(option.text);
  label.append(choice, text);

  let tagText = "";
  if (answered && chosen) tagText = recommended ? "Chosen · recommended" : "Chosen";
  else if (recommended) tagText = "Recommended";
  if (tagText) {
    const tag = document.createElement("span");
    tag.className = "rectag recommended-tag";
    tag.textContent = tagText;
    label.append(tag);
  }

  if (option.letter === "X") {
    label.classList.add("other-option");
    const field = document.createElement("input");
    field.type = "text";
    field.className = "other-input";
    field.dataset.other = "";
    field.placeholder = "Describe your answer";
    field.setAttribute("aria-label", `Describe other answer for ${question.id}`);
    field.value = other || "";
    field.disabled = answered;
    field.hidden = !chosen;
    label.append(field);
  }
  return label;
}

function renderNote(questionId, value) {
  const label = document.createElement("label");
  label.className = "note question-note";
  const title = document.createElement("span");
  title.textContent = "Note for the agent";
  const input = document.createElement("input");
  input.type = "text";
  input.dataset.note = "";
  input.value = value;
  input.placeholder = "Anything the recommendation missed? (optional)";
  input.setAttribute("aria-label", `Note for the agent about ${questionId}`);
  label.append(title, input);
  return label;
}

function handleFormChange(event) {
  if (!event.target.matches("input[data-choice]")) return;
  syncOtherFields(event.target.closest(".qcard"));
  persistCurrentDraft();
  // Choosing "Other" is a promise to type: put the caret in the field.
  if (event.target.value === "X" && event.target.checked) {
    event.target.closest(".option")?.querySelector("input[data-other]")?.focus();
  }
}

function handleFormInput(event) {
  if (!event.target.matches("input[data-other], input[data-note]")) return;
  persistCurrentDraft();
}

function handleFormFocus(event) {
  if (!event.target.matches("input[data-other]")) return;
  const label = event.target.closest(".option");
  const choice = label?.querySelector("input[data-choice]");
  if (choice && !choice.checked && !choice.disabled) {
    choice.checked = true;
    syncOtherFields(choice.closest(".qcard"));
    persistCurrentDraft();
  }
}

function syncOtherFields(card) {
  if (!card) return;
  for (const label of card.querySelectorAll(".other-option")) {
    const choice = label.querySelector("input[data-choice]");
    const field = label.querySelector("input[data-other]");
    if (field) field.hidden = !choice?.checked;
  }
}

function persistCurrentDraft() {
  if (!current || submitted() || elements.view.classList.contains("answered")) return;
  try {
    const answers = collectAnswers(false);
    sessionStorage.setItem(draftKey(current.questions.sha256), JSON.stringify({ answers: Object.fromEntries(
      answers.map((answer) => [answer.id, answer]),
    ) }));
  } catch {
    // sessionStorage can be unavailable in hardened browser profiles.
  }
}

function restoreDraft(sha256) {
  try {
    const value = JSON.parse(sessionStorage.getItem(draftKey(sha256)) || "null");
    return value && typeof value === "object" && value.answers && typeof value.answers === "object"
      ? value
      : null;
  } catch {
    sessionStorage.removeItem(draftKey(sha256));
    return null;
  }
}

function draftKey(sha256) {
  return `${DRAFT_PREFIX}${sha256}`;
}

function collectAnswers(validate) {
  const answers = [];
  for (const block of elements.content.querySelectorAll(".qblock")) {
    const labels = [...block.querySelectorAll("input[data-choice]:checked")].map((input) => input.value);
    const otherField = block.querySelector("input[data-other]");
    const noteField = block.querySelector("input[data-note]");
    const other = labels.includes("X") ? (otherField?.value || "").trim() : "";
    if (validate && labels.length === 0) {
      throw answerError(`Choose an answer for ${block.dataset.questionId}.`, block.querySelector("input[data-choice]"));
    }
    if (validate && labels.includes("X") && !other) {
      throw answerError(`${block.dataset.questionId} needs a description for Other.`, otherField);
    }
    const answer = { id: block.dataset.questionId, labels };
    if (other) answer.other = other;
    const note = (noteField?.value || "").trim();
    if (note) answer.note = note;
    answers.push(answer);
  }
  return answers;
}

function answerError(message, field) {
  const error = new Error(message);
  error.field = field;
  return error;
}

async function saveAnswers() {
  if (saving || !current || store.view?.kind !== "questions" || elements.view.classList.contains("answered")) return;
  if (submitted()) return;
  const round = current.questions;

  let answers;
  try {
    answers = collectAnswers(true);
  } catch (error) {
    showBanner(error.message, "error");
    error.field?.focus();
    return;
  }

  saving = true;
  setFormLocked(true);
  elements.form.setAttribute("aria-busy", "true");
  try {
    const result = await api.post("/api/answers", {
      questions_file: round.path,
      source_sha256: round.sha256,
      answers,
    });
    sessionStorage.removeItem(draftKey(round.sha256));
    // The daemon's next state push carries `submitted`; lock and say so now so
    // the click is acknowledged before it arrives.
    elements.view.classList.add("submitted");
    store.set({ questionsState: "submitted" });
    showBanner(SUBMITTED_MESSAGE, "success");
    store.emit("answers-saved", result);
  } catch (error) {
    setFormLocked(false);
    if (error.status === 409) {
      const message = /not published/.test(error.message || "") ? "The agent is still preparing this round; this page updates when it is ready." : "Questions changed - reload";
      showBanner(message, "error");
      store.emit("notice", { message, kind: "error" });
    } else {
      showBanner(`Answers were not saved: ${error.message}`, "error");
    }
  } finally {
    saving = false;
    elements.form.removeAttribute("aria-busy");
  }
}

function setFormLocked(locked) {
  for (const input of elements.content.querySelectorAll("input")) input.disabled = locked;
}

function showBanner(message, kind) {
  elements.banner.textContent = message;
  elements.banner.className = `questions-banner ${kind}`;
  elements.banner.hidden = false;
}

function clearBanner() {
  elements.banner.textContent = "";
  elements.banner.className = "questions-banner";
  elements.banner.hidden = true;
}

function parseRecordedAnswer(answer) {
  if (typeof answer !== "string") return { labels: [], other: "" };
  const match = /^([A-Z](?:\s*,\s*[A-Z])*)(?:\s+[—-]\s+(.+))?$/i.exec(answer.trim());
  if (!match) return { labels: [], other: "" };
  return {
    labels: match[1].split(",").map((label) => label.trim().toUpperCase()),
    other: (match[2] || "").trim(),
  };
}

function recommendedLetter(question, guide) {
  const letter = guide?.recommendation;
  return question.options.some((option) => option.letter === letter) ? letter : null;
}

function parseGuide(html) {
  const stripped = String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  const parsed = new DOMParser().parseFromString(stripped, "text/html");
  parsed.querySelectorAll("script").forEach((script) => script.remove());
  const guide = new Map();
  let svgIndex = 0;
  for (const section of parsed.querySelectorAll("section[data-aidlc-question]")) {
    const id = section.getAttribute("data-aidlc-question") || "";
    if (!/^Q\d+$/.test(id) || guide.has(id)) continue;
    const recommendationNode = section.querySelector("[data-aidlc-recommend]");
    const rawRecommendation = recommendationNode?.getAttribute("data-aidlc-recommend")?.toUpperCase() || "";
    const content = document.createElement("div");
    for (const child of section.childNodes) {
      const safe = sanitizeHtmlNode(child, `${id.toLowerCase()}-${++svgIndex}-`);
      if (safe) content.append(safe);
    }
    guide.set(id, {
      recommendation: /^[A-Z]$/.test(rawRecommendation) ? rawRecommendation : null,
      recommendationText: recommendationNode?.textContent?.trim() || "",
      content,
    });
  }
  return guide;
}

function sanitizeHtmlNode(source, svgPrefix) {
  if (source.nodeType === Node.TEXT_NODE) return document.createTextNode(source.textContent || "");
  if (source.nodeType !== Node.ELEMENT_NODE) return null;
  const tag = source.localName.toLowerCase();
  if (BLOCKED_TAGS.has(tag)) return null;
  if (tag === "svg") return sanitizeSvg(source, svgPrefix);
  if (!HTML_TAGS.has(tag)) {
    const fragment = document.createDocumentFragment();
    for (const child of source.childNodes) {
      const safe = sanitizeHtmlNode(child, svgPrefix);
      if (safe) fragment.append(safe);
    }
    return fragment;
  }

  const element = document.createElement(tag);
  copyHtmlAttributes(source, element);
  for (const child of source.childNodes) {
    const safe = sanitizeHtmlNode(child, svgPrefix);
    if (safe) element.append(safe);
  }
  return element;
}

function copyHtmlAttributes(source, target) {
  for (const attribute of source.attributes) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on") || name === "style") continue;
    if (!HTML_ATTRIBUTES.has(name) && !name.startsWith("aria-")) continue;
    if ((name === "href" || name === "src") && hasScheme(attribute.value)) continue;
    target.setAttribute(name, attribute.value);
  }
}

function sanitizeSvg(source, prefix) {
  const ids = new Map();
  for (const node of [source, ...source.querySelectorAll("[id]")]) {
    const id = node.getAttribute("id");
    if (id) ids.set(id, `${prefix}${id.replace(/[^A-Za-z0-9_-]/g, "-")}`);
  }
  return sanitizeSvgNode(source, ids);
}

function sanitizeSvgNode(source, ids) {
  if (source.nodeType === Node.TEXT_NODE) return document.createTextNode(source.textContent || "");
  if (source.nodeType !== Node.ELEMENT_NODE) return null;
  const tag = source.localName.toLowerCase();
  if (!SVG_TAGS.has(tag) || tag === "foreignobject") return null;
  const element = document.createElementNS(SVG_NAMESPACE, tag);
  for (const attribute of source.attributes) {
    const lower = attribute.name.toLowerCase();
    if (lower.startsWith("on") || lower === "style" || !SVG_ATTRIBUTES.has(lower)) continue;
    if ((lower === "href" || lower === "xlink:href") && hasScheme(attribute.value)) continue;
    let value = attribute.value;
    if (/url\s*\(/i.test(value) && !/url\s*\(\s*#[^)]+\)/i.test(value)) continue;
    if (lower === "id") value = ids.get(value) || value;
    value = value.replace(/url\(\s*#([^)\s]+)\s*\)/gi, (_, id) => `url(#${ids.get(id) || id})`);
    if ((lower === "href" || lower === "xlink:href") && value.startsWith("#")) {
      value = `#${ids.get(value.slice(1)) || value.slice(1)}`;
    }
    element.setAttribute(SVG_ATTRIBUTE_NAMES.get(lower) || attribute.name, value);
  }
  for (const child of source.childNodes) {
    const safe = sanitizeSvgNode(child, ids);
    if (safe) element.append(safe);
  }
  return element;
}

function hasScheme(value) {
  const trimmed = String(value).trim();
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) || trimmed.startsWith("//");
}

function decorateGuide(explain) {
  for (const heading of explain.querySelectorAll("h3")) {
    const text = normalize(heading.textContent);
    heading.classList.add("why");
    if (text === "recommendation") {
      heading.classList.add("recommendation-heading");
      heading.nextElementSibling?.classList.add("recommendation");
    } else if (text === "related decisions") {
      heading.nextElementSibling?.classList.add("related");
    }
  }
}

function highlightRecommendation(explain, optionText, recommendationText) {
  const candidates = new Set([
    ...textVariants(optionText),
    ...textVariants(recommendationText.split(/\.(?:\s|$)/, 1)[0]),
  ]);
  for (const row of explain.querySelectorAll("tbody tr, table tr")) {
    const first = row.querySelector("td");
    if (!first) continue;
    const rowText = normalize(first.textContent);
    if ([...candidates].some((candidate) => candidate && (
      rowText === candidate || rowText.startsWith(`${candidate} `) || candidate.startsWith(`${rowText} `)
    ))) {
      row.classList.add("recommended-row");
    }
  }
}

function textVariants(value) {
  const text = normalize(value);
  return [
    text,
    normalize(text.replace(/\s*\([^)]*\)\s*/g, " ")),
    normalize(text.split(/\s+(?:that|—|–)\s+/)[0]),
  ];
}

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function basename(path) {
  return String(path || "").split("/").pop() || "answers.json";
}

function humanize(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Inline Markdown only (code, bold, italic) — question prose never carries block syntax. */
function inlineMarkdown(value) {
  const escaped = String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>");
}
