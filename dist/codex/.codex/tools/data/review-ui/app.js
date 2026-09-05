(() => {
  "use strict";

  const elements = {
    projectName: document.querySelector("#project-name"),
    intentName: document.querySelector("#intent-name"),
    stageName: document.querySelector("#stage-name"),
    stageStatus: document.querySelector("#stage-status"),
    stageSummary: document.querySelector("#stage-summary"),
    artifactList: document.querySelector("#artifact-list"),
    questionsNav: document.querySelector("#questions-nav"),
    questionsButton: document.querySelector("#questions-button"),
    questionsBadge: document.querySelector("#questions-badge"),
    recordTree: document.querySelector("#record-tree"),
    viewer: document.querySelector("#viewer"),
    appGrid: document.querySelector(".app-grid"),
    headerActions: document.querySelector("#header-actions"),
    viewerActions: document.querySelector("#viewer-actions"),
    feedbackDrawer: document.querySelector("#feedback-drawer"),
    questionsView: document.querySelector("#questions-view"),
    questionsForm: document.querySelector("#questions-form"),
    questionsMeta: document.querySelector("#questions-meta"),
    questionsContent: document.querySelector("#questions-content"),
    questionsBanner: document.querySelector("#questions-banner"),
    saveAnswersButton: document.querySelector("#save-answers-button"),
    guideContent: document.querySelector("#guide-content"),
    artifactMeta: document.querySelector("#artifact-meta"),
    notice: document.querySelector("#notice"),
    pausedOverlay: document.querySelector("#paused-overlay"),
    exportButton: document.querySelector("#export-button"),
    diffButton: document.querySelector("#diff-button"),
    globalCommentButton: document.querySelector("#global-comment-button"),
    editButton: document.querySelector("#edit-button"),
    editorPanel: document.querySelector("#editor-panel"),
    sourceEditor: document.querySelector("#source-editor"),
    addEditButton: document.querySelector("#add-edit-button"),
    cancelEditButton: document.querySelector("#cancel-edit-button"),
    diffPanel: document.querySelector("#diff-panel"),
    diffTitle: document.querySelector("#diff-title"),
    diffOutput: document.querySelector("#diff-output"),
    closeDiffButton: document.querySelector("#close-diff-button"),
    feedbackEmpty: document.querySelector("#feedback-empty"),
    annotationList: document.querySelector("#annotation-list"),
    generalNotes: document.querySelector("#general-notes"),
    sendFeedbackButton: document.querySelector("#send-feedback-button"),
    feedbackBanner: document.querySelector("#feedback-banner"),
    selectionToolbar: document.querySelector("#selection-toolbar"),
    anchorConfirm: document.querySelector("#anchor-confirm"),
    anchorPreview: document.querySelector("#anchor-preview"),
    revisionDialog: document.querySelector("#revision-dialog"),
    revisionSelect: document.querySelector("#revision-select"),
    showDiffButton: document.querySelector("#show-diff-button"),
  };

  const model = {
    state: null,
    view: "artifact",
    artifact: null,
    artifactPath: null,
    htmlFrame: null,
    questions: null,
    questionsStorageKey: null,
    guideFrame: null,
    guidePath: null,
    submittedIds: [],
    guideBaseUrl: null,
    recommendations: new Map(),
    selectionAnchor: null,
    pendingHtmlAnchor: null,
    annotations: [],
    storageKey: null,
    mermaidPromise: null,
    socketRetry: 0,
    socketTimer: null,
  };

  const KIND_LABELS = {
    comment: "Comment",
    delete: "Delete",
    "looks-good": "Looks good",
    label: "Label",
    edit: "Edit",
  };

  function apiUrl(path, params = {}) {
    const url = new URL(path, window.location.href);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    return `${url.pathname}${url.search}`;
  }

  const PAUSED_RECONNECTING = "Live updates paused — reconnecting…";
  const PAUSED_SESSION_RENEWING = "Review session renewed — reloading…";
  const PAUSED_SESSION_ENDED =
    "Your review session ended (the daemon restarted or the session expired). Run /aidlc --status in your harness and open the new link.";
  const PAUSED_DAEMON_DOWN =
    "Review daemon stopped — it restarts with your next AI-DLC session. Run /aidlc --doctor for the manual command.";
  const REAUTH_STAMP_KEY = "aidlc-review-reauth-at";
  const REAUTH_LOOP_WINDOW_MS = 15_000;

  function showPaused(message) {
    elements.pausedOverlay.textContent = message;
    elements.pausedOverlay.classList.remove("connected");
  }

  /**
   * The cookie no longer matches the daemon's token (it restarted, or the
   * session lapsed). A top-level reload is a user-initiated navigation the
   * daemon trusts, so it lands back in the app with a fresh cookie — no link
   * needed. If we reloaded moments ago and are still signed out (strict mode,
   * or a browser without Fetch Metadata), stop looping and say what to do.
   */
  function sessionLost() {
    const last = Number(sessionStorage.getItem(REAUTH_STAMP_KEY) || 0);
    if (Date.now() - last < REAUTH_LOOP_WINDOW_MS) {
      showPaused(PAUSED_SESSION_ENDED);
      return;
    }
    sessionStorage.setItem(REAUTH_STAMP_KEY, String(Date.now()));
    showPaused(PAUSED_SESSION_RENEWING);
    window.location.reload();
  }

  async function requestJson(path, options) {
    const response = await fetch(path, options);
    if (response.status === 401) {
      sessionLost();
      throw new Error("review session ended — renewing");
    }
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body = await response.json();
        if (typeof body.error === "string") detail = body.error;
      } catch {
        // A non-JSON response still has a useful status line.
      }
      throw new Error(detail);
    }
    return response.json();
  }

  function showNotice(message, kind = "error") {
    elements.notice.textContent = message;
    elements.notice.className = `notice ${kind}`;
    elements.notice.hidden = false;
  }

  function clearNotice() {
    elements.notice.hidden = true;
    elements.notice.textContent = "";
  }

  function basename(path) {
    const parts = String(path || "").split("/");
    return parts[parts.length - 1] || path;
  }

  function projectName(path) {
    const clean = String(path || "").replace(/[\\/]$/, "");
    return clean.split(/[\\/]/).pop() || "AI-DLC Review";
  }

  function feedbackStorageKey(state) {
    if (!state || !state.current || !state.current.stage) return null;
    return `aidlc-review-feedback:${state.current.stage}:${state.current.revision}`;
  }

  function persistAnnotations() {
    if (!model.storageKey) return;
    if (model.annotations.length === 0) {
      sessionStorage.removeItem(model.storageKey);
      return;
    }
    sessionStorage.setItem(model.storageKey, JSON.stringify(model.annotations));
  }

  function restoreAnnotations(key) {
    model.annotations = [];
    if (!key) return;
    try {
      const value = JSON.parse(sessionStorage.getItem(key) || "[]");
      if (Array.isArray(value)) model.annotations = value.filter(isStoredAnnotation);
    } catch {
      sessionStorage.removeItem(key);
    }
  }

  function isStoredAnnotation(value) {
    return Boolean(
      value &&
        typeof value === "object" &&
        typeof value.artifact === "string" &&
        typeof value.kind === "string" &&
        Array.isArray(value.heading_path),
    );
  }

  function decisionHint() {
    return document.querySelector('input[name="decision"]:checked')?.value || "none";
  }
  function questionsStorageKey(result) {
    return result?.path && result?.sha256
      ? `aidlc-review-questions:${result.path}:${result.sha256}`
      : null;
  }

  function setQuestionsMode(active) {
    model.view = active ? "questions" : "artifact";
    elements.appGrid.classList.toggle("questions-mode", active);
    elements.questionsView.hidden = !active;
    elements.viewerActions.hidden = active;
    elements.headerActions.hidden = active;
    elements.feedbackDrawer.hidden = active;
    elements.viewer.hidden = active;
    elements.questionsButton.setAttribute("aria-current", active ? "page" : "false");
    if (active) {
      closeSelectionToolbar();
      closeAnchorConfirm();
      elements.editorPanel.hidden = true;
      elements.diffPanel.hidden = true;
    }
  }

  function ordinaryQuestions() {
    return (model.questions?.questions || []).filter((question) => !question.confirmation);
  }

  function updateQuestionsBadge(result = model.questions) {
    const questions = (result?.questions || []).filter((question) => !question.confirmation);
    let answered = questions.filter((question) => Boolean(question.answer?.trim())).length;
    if (result === model.questions && model.view === "questions") {
      answered = questions.filter((question) => {
        const card = elements.questionsContent.querySelector(`[data-question-id="${question.id}"]`);
        return Boolean(card?.querySelector('input[data-choice]:checked'));
      }).length;
    }
    elements.questionsBadge.removeAttribute("title");
    elements.questionsBadge.textContent = `${answered}/${questions.length}`;
    elements.questionsBadge.setAttribute(
      "aria-label",
      `${answered} of ${questions.length} questions answered`,
    );
  }

  async function refreshQuestionsBadge(pointer) {
    if (!pointer?.file) return;
    elements.questionsBadge.textContent = "…";
    try {
      const result = await requestJson(apiUrl("/api/questions", { path: pointer.file }));
      if (model.state?.questions?.file === pointer.file && model.view !== "questions") {
        updateQuestionsBadge(result);
      }
    } catch (error) {
      if (model.state?.questions?.file === pointer.file && model.view !== "questions") {
        elements.questionsBadge.textContent = "!";
        elements.questionsBadge.setAttribute("aria-label", "Questions could not be loaded");
        elements.questionsBadge.title = error.message;
      }
    }
  }

  function questionInitialAnswer(question) {
    const entry = { id: question.id };
    const valid = new Set(question.options.map((option) => option.letter).filter(Boolean));
    const raw = typeof question.answer === "string" ? question.answer.trim() : "";
    const separator = raw.search(/\s+[—–-]\s+/);
    const labelsPart = separator >= 0 ? raw.slice(0, separator) : raw;
    const labels = labelsPart
      .split(",")
      .map((label) => label.trim())
      .filter((label) => valid.has(label));
    if (labels.length) entry.labels = question.multi ? labels : labels.slice(0, 1);
    if (entry.labels?.includes("X") && separator >= 0) {
      const other = raw.slice(separator).replace(/^\s*[—–-]\s*/, "").trim();
      if (other) entry.other = other;
    }
    if (typeof question.note === "string" && question.note.trim()) entry.note = question.note.trim();
    return entry;
  }

  function renderQuestions(result) {
    elements.questionsContent.replaceChildren();
    const ordinary = result.questions.filter((question) => !question.confirmation);
    for (const question of result.questions) {
      if (question.confirmation) renderConfirmation(question);
      else renderQuestionCard(question, questionInitialAnswer(question));
    }
    elements.questionsMeta.textContent = `${basename(result.path)} · ${ordinary.length} question${ordinary.length === 1 ? "" : "s"}`;
    model.savedAnswers = JSON.stringify(collectQuestionAnswers());
    restoreQuestionAnswers();
    syncQuestionForm();
  }

  function renderQuestionCard(question, initial) {
    const card = document.createElement("fieldset");
    const legend = document.createElement("legend");
    const prompt = document.createElement("p");
    const options = document.createElement("div");
    card.className = "question-card";
    card.dataset.questionId = question.id;
    legend.textContent = question.title;
    prompt.className = "question-prompt";
    prompt.textContent = question.prompt;
    options.className = "question-options";

    for (const option of question.options) {
      if (!option.letter) continue;
      const row = document.createElement("div");
      const label = document.createElement("label");
      const input = document.createElement("input");
      const text = document.createElement("span");
      row.className = "question-option";
      row.dataset.optionLetter = option.letter;
      input.type = question.multi ? "checkbox" : "radio";
      input.name = `question-${question.id}`;
      input.value = option.letter;
      input.dataset.choice = "";
      input.checked = initial.labels?.includes(option.letter) || false;
      text.textContent = `${option.letter}. ${option.text}`;
      label.append(input, text);
      row.append(label);
      if (option.letter === "X") {
        const otherLabel = document.createElement("label");
        const otherInput = document.createElement("input");
        otherLabel.className = "other-input";
        otherLabel.textContent = "Other answer";
        otherInput.type = "text";
        otherInput.dataset.other = "";
        otherInput.value = initial.other || "";
        otherLabel.append(otherInput);
        row.append(otherLabel);
      }
      options.append(row);
    }

    const noteLabel = document.createElement("label");
    const note = document.createElement("textarea");
    noteLabel.className = "question-note";
    noteLabel.textContent = "Note (optional)";
    note.rows = 3;
    note.dataset.note = "";
    note.value = initial.note || "";
    noteLabel.append(note);
    card.append(legend, prompt, options, noteLabel);
    card.addEventListener("click", () => navigateGuide(question.id));
    card.addEventListener("focusin", () => navigateGuide(question.id));
    elements.questionsContent.append(card);
  }

  function renderConfirmation(question) {
    const section = document.createElement("section");
    const title = document.createElement("h2");
    const prompt = document.createElement("p");
    const choices = document.createElement("ul");
    section.className = "question-card confirmation-card";
    section.dataset.questionId = question.id;
    title.textContent = question.title;
    prompt.className = "question-prompt";
    prompt.textContent = question.prompt;
    for (const option of question.options) {
      const item = document.createElement("li");
      item.textContent = option.text;
      choices.append(item);
    }
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "Read-only — confirm this summary in the terminal after your answers are applied.";
    section.append(title, prompt, choices, hint);
    elements.questionsContent.append(section);
  }

  function applyQuestionEntry(entry) {
    if (!entry || typeof entry !== "object" || !/^Q\d+$/.test(entry.id)) return;
    const question = ordinaryQuestions().find((candidate) => candidate.id === entry.id);
    const card = elements.questionsContent.querySelector(`[data-question-id="${entry.id}"]`);
    if (!question || !card) return;
    const valid = new Set(question.options.map((option) => option.letter).filter(Boolean));
    const labels = Array.isArray(entry.labels)
      ? entry.labels.filter((letter) => typeof letter === "string" && valid.has(letter))
      : [];
    for (const input of card.querySelectorAll("input[data-choice]")) {
      input.checked = labels.includes(input.value);
    }
    const other = card.querySelector("input[data-other]");
    if (other && typeof entry.other === "string" && entry.other.length <= 100_000) {
      other.value = entry.other;
    }
    const note = card.querySelector("textarea[data-note]");
    if (note && typeof entry.note === "string" && entry.note.length <= 100_000) {
      note.value = entry.note;
    }
  }

  function restoreQuestionAnswers() {
    if (!model.questionsStorageKey) return;
    try {
      const saved = JSON.parse(sessionStorage.getItem(model.questionsStorageKey) || "[]");
      if (!Array.isArray(saved) || saved.length > 200) throw new Error("Invalid saved answers");
      for (const entry of saved) applyQuestionEntry(entry);
    } catch {
      sessionStorage.removeItem(model.questionsStorageKey);
    }
  }

  function collectQuestionAnswers() {
    const answers = [];
    for (const question of ordinaryQuestions()) {
      const card = elements.questionsContent.querySelector(`[data-question-id="${question.id}"]`);
      if (!card) continue;
      const labels = [...card.querySelectorAll("input[data-choice]:checked")].map(
        (input) => input.value,
      );
      const other = card.querySelector("input[data-other]")?.value.trim() || "";
      const note = card.querySelector("textarea[data-note]")?.value.trim() || "";
      if (!labels.length) continue;
      const entry = { id: question.id };
      if (labels.length) entry.labels = labels;
      if (labels.includes("X") && other) entry.other = other;
      if (note) entry.note = note;
      answers.push(entry);
    }
    return answers;
  }

  function syncOtherInputs() {
    for (const card of elements.questionsContent.querySelectorAll(".question-card")) {
      const other = card.querySelector("input[data-other]");
      if (!other) continue;
      const selected = card.querySelector('input[data-choice][value="X"]')?.checked || false;
      other.parentElement.hidden = !selected;
      other.required = selected;
      if (!selected) other.setCustomValidity("");
    }
  }

  function syncQuestionForm() {
    syncOtherInputs();
    updateQuestionsBadge();
    const answers = collectQuestionAnswers();
    const serialized = JSON.stringify(answers);
    const dirty = serialized !== model.savedAnswers;
    elements.saveAnswersButton.disabled = !dirty || answers.length === 0;
    if (dirty) {
      elements.questionsBanner.hidden = true;
      if (model.questionsStorageKey) {
        try {
          sessionStorage.setItem(model.questionsStorageKey, serialized);
        } catch {
          showNotice("Could not preserve pending answers in this browser session.", "info");
        }
      }
    } else if (model.questionsStorageKey) {
      sessionStorage.removeItem(model.questionsStorageKey);
    }
  }

  function renderGuide(pointer) {
    model.guideFrame = null;
    model.guidePath = pointer?.guide || null;
    model.guideBaseUrl = null;
    elements.guideContent.replaceChildren();
    if (!model.guidePath) {
      elements.guideContent.className = "guide-content muted";
      elements.guideContent.textContent = "No explainer yet";
      return;
    }
    const frame = document.createElement("iframe");
    model.guideBaseUrl = apiUrl("/api/raw", { path: model.guidePath });
    frame.className = "guide-frame";
    frame.title = `Explainer for ${model.questions?.stage || "questions"}`;
    frame.sandbox = "allow-scripts";
    frame.src = model.guideBaseUrl;
    elements.guideContent.className = "guide-content";
    elements.guideContent.append(frame);
    model.guideFrame = frame;
  }

  function navigateGuide(questionId) {
    if (!model.guideFrame || !model.guideBaseUrl || !/^Q\d+$/.test(questionId)) return;
    const target = `${model.guideBaseUrl}#${questionId}`;
    if (model.guideFrame.getAttribute("src") !== target) model.guideFrame.src = target;
  }

  function isGuideRecommendations(data) {
    if (!data || typeof data !== "object" || data.type !== "aidlc-guide") return false;
    if (!data.recommendations || typeof data.recommendations !== "object" || Array.isArray(data.recommendations)) {
      return false;
    }
    const entries = Object.entries(data.recommendations);
    return (
      entries.length <= 200 &&
      entries.every(([id, letter]) => /^Q\d+$/.test(id) && /^[A-Z]$/.test(letter))
    );
  }

  function receiveGuideRecommendations(event) {
    const frame = model.guideFrame;
    if (!frame || event.source !== frame.contentWindow || !isGuideRecommendations(event.data)) return;
    model.recommendations = new Map(Object.entries(event.data.recommendations));
    for (const question of ordinaryQuestions()) {
      const letter = model.recommendations.get(question.id);
      const card = elements.questionsContent.querySelector(`[data-question-id="${question.id}"]`);
      const row = card?.querySelector(`[data-option-letter="${letter}"]`);
      if (!row) continue;
      if (!row.querySelector(".recommended-tag")) {
        const tag = document.createElement("span");
        tag.className = "recommended-tag";
        tag.textContent = "Recommended";
        row.querySelector("label")?.append(tag);
      }
      if (!question.answer?.trim() && !card.querySelector("input[data-choice]:checked")) {
        row.querySelector("input[data-choice]").checked = true;
      }
    }
    syncQuestionForm();
  }

  async function openQuestions(options = {}) {
    const pointer = model.state?.questions;
    if (!pointer?.file) return;
    if (pointer.preparing) {
      // The agent is still writing the explainer. Showing the form now would
      // mean no recommendations and prose arriving underneath the human.
      setQuestionsMode(true);
      clearNotice();
      model.questions = null;
      model.guideFrame = null;
      elements.questionsBanner.hidden = true;
      elements.questionsContent.className = "questions-content loading";
      elements.questionsContent.textContent = "Preparing your questions — the explainer with trade-offs and recommendations is being written. This view opens on its own when it is ready.";
      elements.saveAnswersButton.disabled = true;
      renderGuide(null);
      return;
    }
    const refreshing =
      Boolean(options.refresh) && model.questions?.path === pointer.file && model.view === "questions";
    setQuestionsMode(true);
    clearNotice();
    if (!refreshing) {
      elements.questionsBanner.hidden = true;
      elements.questionsContent.className = "questions-content loading";
      elements.questionsContent.textContent = "Loading questions…";
      elements.saveAnswersButton.disabled = true;
    }
    const path = pointer.file;
    try {
      const result = await requestJson(apiUrl("/api/questions", { path }));
      if (model.state?.questions?.file !== path) return;
      if (refreshing && result.sha256 === model.questions.sha256) {
        if (pointer.guide !== model.guidePath) renderGuide(pointer);
        updateQuestionsBadge();
        return;
      }
      const changed = refreshing && result.sha256 !== model.questions.sha256;
      // The common reason the file changes right after a Save is answers-apply
      // writing this tab's own submission back. That is success, not a warning.
      const applied = changed && submittedAnswersApplied(result);
      // Every later write to the file (answer timestamps, mode stamps, the
      // consolidated-summary confirmation) is the agent moving on. Only a human
      // who still holds UNSAVED choices needs to hear that the ground moved.
      const staleDraft = changed && JSON.stringify(collectQuestionAnswers()) !== model.savedAnswers;
      model.questions = result;
      model.questionsStorageKey = questionsStorageKey(result);
      model.recommendations = new Map();
      elements.questionsContent.className = "questions-content";
      elements.questionsBanner.hidden = true;
      renderQuestions(result);
      renderGuide(pointer);
      updateTitleBadge(model.state);
      if (applied) {
        model.submittedIds = [];
        showNotice("Your answers were applied — the agent is continuing in the terminal.", "info");
      } else if (staleDraft) {
        showNotice("Questions changed while you had unsaved choices. Review the latest version before saving.", "info");
      }
    } catch (error) {
      if (model.state?.questions?.file !== path) return;
      if (!refreshing) {
        model.questions = null;
        model.questionsStorageKey = null;
        elements.questionsContent.className = "questions-content empty-state";
        elements.questionsContent.textContent = "Could not load questions.";
        renderGuide(null);
      }
      showNotice(`Could not load questions: ${error.message}`);
    }
  }

  // True when every question this tab submitted now carries a recorded answer:
  // the file change we are looking at is answers-apply writing our own Save back.
  function submittedAnswersApplied(result) {
    const submitted = model.submittedIds || [];
    if (!submitted.length) return false;
    const answered = new Set((result.questions || []).filter((q) => q.answer !== null).map((q) => q.id));
    return submitted.every((id) => answered.has(id));
  }

  async function saveQuestionAnswers(event) {
    event.preventDefault();
    if (!model.questions || !elements.questionsForm.reportValidity()) return;
    const answers = collectQuestionAnswers();
    elements.saveAnswersButton.disabled = true;
    elements.saveAnswersButton.textContent = "Saving…";
    elements.questionsBanner.hidden = true;
    clearNotice();
    try {
      const result = await requestJson("/api/answers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questions_file: model.questions.path,
          source_sha256: model.questions.sha256,
          answers,
        }),
      });
      model.savedAnswers = JSON.stringify(answers);
      model.submittedIds = answers.map((entry) => entry.id);
      if (model.questionsStorageKey) sessionStorage.removeItem(model.questionsStorageKey);
      elements.questionsBanner.textContent = `Saved as ${basename(result.file)} — the agent is picking your answers up now.`;
      elements.questionsBanner.hidden = false;
    } catch (error) {
      showNotice(`Could not save answers: ${error.message}`);
    } finally {
      elements.saveAnswersButton.textContent = "Save answers";
      syncQuestionForm();
    }
  }

  // Nothing of the human's is in flight in this tab: no unsent annotations or
  // notes, and the source editor is closed. Only then may a state push move them.
  function tabIsIdle() {
    return (
      model.annotations.length === 0 &&
      elements.generalNotes.value.trim() === "" &&
      elements.editorPanel.hidden
    );
  }

  // Every answerable question in the loaded round carries a recorded answer and
  // the form holds no unsaved edits: the human is done here.
  function questionsRoundFinished() {
    const questions = model.questions?.questions || [];
    if (!questions.length) return false;
    const allAnswered = questions.every((q) => q.confirmation || q.answer !== null);
    return allAnswered && JSON.stringify(collectQuestionAnswers()) === model.savedAnswers;
  }

  // A background tab cannot be focused from the server; the tab title is the
  // one cue every browser shows. Badge it while something awaits the human.
  const BASE_TITLE = "AI-DLC Review";
  function updateTitleBadge(state) {
    const loaded = model.questions?.path === state?.questions?.file ? model.questions.questions || [] : null;
    // Badge only a browser round that is ready for the human and still unanswered.
    const roundOpen =
      Boolean(state?.questions?.ready) && !(loaded && loaded.length > 0 && loaded.every((q) => q.confirmation || q.answer !== null));
    const awaiting = state?.current?.state === "awaiting-approval" || roundOpen;
    document.title = awaiting ? `(1) ${BASE_TITLE}` : BASE_TITLE;
  }

  async function refreshState() {
    try {
      const nextState = await requestJson("/api/state");
      const nextKey = feedbackStorageKey(nextState);
      if (nextKey !== model.storageKey) {
        persistAnnotations();
        model.storageKey = nextKey;
        restoreAnnotations(nextKey);
        elements.generalNotes.value = "";
        renderAnnotations();
      }
      const priorQuestionsFile = model.state?.questions?.file || null;
      const priorReady = Boolean(model.state?.questions?.ready);
      model.state = nextState;
      renderState();
      updateTitleBadge(nextState);

      if (!nextState.questions && model.view === "questions") {
        model.questions = null;
        model.questionsStorageKey = null;
        model.guideFrame = null;
        setQuestionsMode(false);
        showNotice("Questions are no longer available. The current review state has changed.", "info");
      } else if (nextState.questions && model.view === "questions") {
        // The gate opened while the tab still shows a round the human already
        // finished: move them to the artifact under review. Unsaved choices
        // or an unanswered round keep the Questions view.
        const gateOpened =
          nextState.current?.state === "awaiting-approval" &&
          model.state !== null &&
          (nextState.manifest?.artifacts || []).some((item) => item.exists) &&
          questionsRoundFinished() &&
          tabIsIdle();
        if (!gateOpened) {
          await openQuestions({ refresh: priorQuestionsFile === nextState.questions.file });
          return;
        }
        setQuestionsMode(false);
      } else if (nextState.questions) {
        refreshQuestionsBadge(nextState.questions);
        // The round just became READY — explainer complete and checked — and
        // nothing of the human's is in flight here: take them to it. A questions
        // file appearing, or a half-written explainer, is not that moment.
        if (nextState.questions.ready && !priorReady && tabIsIdle()) {
          await openQuestions();
          return;
        }
      }

      const artifacts = nextState.manifest?.artifacts || [];
      const currentStillExists = artifacts.some(
        (item) => item.exists && item.path === model.artifactPath,
      );
      const preferred =
        (currentStillExists && model.artifactPath) ||
        (nextState.manifest?.review_artifact &&
          artifacts.find((item) => item.path === nextState.manifest.review_artifact)?.exists &&
          nextState.manifest.review_artifact) ||
        artifacts.find((item) => item.exists)?.path ||
        null;

      if (preferred) await openArtifact(preferred, { force: true });
      else clearArtifact();
    } catch (error) {
      showNotice(`Could not load review state: ${error.message}`);
    }
  }

  function renderState() {
    const state = model.state;
    elements.projectName.textContent = projectName(state?.project_dir);
    elements.intentName.textContent = state?.intent || "No active intent";

    const current = state?.current;
    const manifest = state?.manifest;
    // Before any gate has published a review pointer (question rounds,
    // authoring), the workflow's own stage is still known — name it.
    elements.stageName.textContent = current?.stage || manifest?.stage || state?.current_stage || "No stage";

    const statusLabels = {
      "awaiting-approval": "Awaiting approval",
      revising: "Revising",
      approved: "Approved",
      none: "Idle",
    };
    const status = current?.state || "none";
    const noneLabel = state?.questions?.preparing
      ? "Preparing questions"
      : state?.questions?.ready
        ? "Questions open"
        : state?.questions
          ? "Questions in the terminal"
          : state?.current_stage
            ? "In progress"
            : "Idle";
    elements.stageStatus.textContent = [state?.stage_status, status === "none" ? noneLabel : statusLabels[status]]
      .filter(Boolean)
      .join(" ");
    elements.stageStatus.dataset.state = status;

    if (manifest) {
      const unit = manifest.unit ? ` · ${manifest.unit}` : "";
      elements.stageSummary.textContent = `${manifest.phase}${unit} · revision ${manifest.revision}`;
    } else if (status === "approved") {
      elements.stageSummary.textContent = "Approved; nothing is currently under review.";
    } else if (state?.questions?.preparing) {
      elements.stageSummary.textContent = "The agent is writing the explainer for this round. Questions opens on its own when it is ready.";
    } else if (state?.questions?.ready) {
      elements.stageSummary.textContent = "A question round is open — answer it under Questions. Artifacts appear here at the approval gate.";
    } else if (state?.questions) {
      elements.stageSummary.textContent = "A question round is being answered in the terminal. The form under Questions mirrors the file.";
    } else if (state?.current_stage) {
      elements.stageSummary.textContent = "The agent is working on this stage. Artifacts appear here at the approval gate.";
    } else {
      elements.stageSummary.textContent = "Nothing is under review.";
    }
    elements.questionsNav.hidden = !state?.questions;
    elements.questionsButton.setAttribute("aria-current", model.view === "questions" ? "page" : "false");
    if (!state?.questions) {
      elements.questionsBadge.textContent = "0/0";
      elements.questionsBadge.setAttribute("aria-label", "0 of 0 questions answered");
      elements.questionsBadge.removeAttribute("title");
    }

    elements.artifactList.replaceChildren();
    for (const artifact of manifest?.artifacts || []) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      const badge = document.createElement("span");
      button.type = "button";
      button.className = "artifact-button";
      button.disabled = !artifact.exists;
      button.dataset.path = artifact.path;
      button.setAttribute(
        "aria-current",
        model.view === "artifact" && artifact.path === model.artifactPath ? "page" : "false",
      );
      button.append(document.createTextNode(artifact.name || basename(artifact.path)));
      badge.className = `file-badge ${artifact.exists ? "exists" : "missing"}`;
      badge.textContent = artifact.exists ? "exists" : "missing";
      button.append(badge);
      button.addEventListener("click", () => openArtifact(artifact.path));
      item.append(button);
      elements.artifactList.append(item);
    }
  }

  function clearArtifact() {
    model.artifact = null;
    model.artifactPath = null;
    model.htmlFrame = null;
    closeSelectionToolbar();
    closeAnchorConfirm();
    elements.viewer.className = "viewer empty-state";
    elements.viewer.replaceChildren();
    const title = document.createElement("h1");
    const text = document.createElement("p");
    title.textContent = "No artifact available";
    text.textContent = "The current stage has no artifact to display.";
    elements.viewer.append(title, text);
    elements.artifactMeta.textContent = "";
    elements.exportButton.disabled = true;
    elements.diffButton.disabled = true;
    elements.globalCommentButton.disabled = true;
    elements.editButton.disabled = true;
    closeEditor();
    closeDiff();
  }

  function isCurrentStageArtifact(path) {
    return Boolean(
      model.state?.manifest?.artifacts?.some((artifact) => artifact.exists && artifact.path === path),
    );
  }

  async function openArtifact(path, options = {}) {
    if (!path) return;
    setQuestionsMode(false);
    if (!options.force && path === model.artifactPath) return;
    clearNotice();
    closeSelectionToolbar();
    closeAnchorConfirm();
    closeEditor();
    closeDiff();
    elements.viewer.className = "viewer loading";
    elements.viewer.textContent = "Loading artifact…";

    try {
      const artifact = await requestJson(apiUrl("/api/artifact", { path }));
      model.artifactPath = path;
      model.artifact = artifact;
      model.htmlFrame = null;
      elements.artifactMeta.textContent = `${basename(path)} · ${artifact.format.toUpperCase()}`;
      elements.exportButton.disabled = false;
      elements.diffButton.disabled = !model.state?.current?.stage_dir;
      const annotatable = isCurrentStageArtifact(path);
      elements.globalCommentButton.disabled = !annotatable;
      elements.editButton.disabled = !annotatable || artifact.format !== "md";

      // Every artifact renders inside the sandboxed iframe: the app never
      // injects artifact-derived HTML into its own privileged document.
      renderInSandbox(path);

      document.querySelectorAll(".artifact-button").forEach((button) => {
        const current = Boolean(button.dataset.path) && button.dataset.path === path;
        button.setAttribute("aria-current", current ? "page" : "false");
      });
    } catch (error) {
      model.artifact = null;
      model.artifactPath = path;
      elements.viewer.className = "viewer empty-state";
      elements.viewer.textContent = `Could not load ${basename(path)}.`;
      elements.exportButton.disabled = true;
      elements.diffButton.disabled = true;
      elements.globalCommentButton.disabled = true;
      elements.editButton.disabled = true;
      showNotice(`Could not load artifact: ${error.message}`);
    }
  }

  function renderInSandbox(path) {
    elements.viewer.className = `viewer ${model.artifact?.format === "md" ? "markdown-viewer" : "html-viewer"}`;
    elements.viewer.replaceChildren();
    const frame = document.createElement("iframe");
    frame.title = basename(path);
    frame.sandbox = "allow-scripts";
    frame.src = apiUrl("/api/raw", { path });
    elements.viewer.append(frame);
    model.htmlFrame = frame;
  }

  // Selections inside the sandbox arrive as bridge messages (receiveHtmlAnchor);
  // nothing in the privileged document is selectable artifact content.
  function handleMarkdownSelection() {
    closeSelectionToolbar();
  }

  function normalizeLine(value) {
    return value
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s?/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
      .replace(/[*_`~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Best-effort source lines for a Markdown selection reported by the bridge:
  // match the selection's first line against the Markdown source.
  function estimateLineRange(selectedText) {
    if (!model.artifact?.source || model.artifact.format !== "md") return {};
    const firstLine = String(selectedText || "")
      .split(/\r?\n/)
      .map((line) => normalizeLine(line))
      .find(Boolean);
    if (!firstLine) return {};

    const sourceLines = model.artifact.source.split(/\r?\n/);
    const index = sourceLines.findIndex((line) => {
      const candidate = normalizeLine(line);
      return candidate &&
        (candidate === firstLine ||
          candidate.includes(firstLine) ||
          firstLine.includes(candidate));
    });
    if (index < 0) return {};
    const selectedLines = Math.max(1, selectedText.split(/\r?\n/).length);
    return { line_start: index + 1, line_end: index + selectedLines };
  }

  function closeSelectionToolbar() {
    elements.selectionToolbar.hidden = true;
    model.selectionAnchor = null;
  }

  function isValidHtmlAnchor(data) {
    if (!data || typeof data !== "object" || data.type !== "aidlc-anchor") return false;
    if (data.selection !== undefined && (typeof data.selection !== "string" || data.selection.length > 4000)) {
      return false;
    }
    if (data.css_path !== undefined && (typeof data.css_path !== "string" || data.css_path.length > 500)) {
      return false;
    }
    if (data.heading_path !== undefined) {
      if (!Array.isArray(data.heading_path) || data.heading_path.length > 12) return false;
      if (!data.heading_path.every((item) => typeof item === "string")) return false;
    }
    return Boolean(data.selection || data.css_path);
  }

  function receiveHtmlAnchor(event) {
    const frame = model.htmlFrame;
    if (!frame || event.source !== frame.contentWindow || !isValidHtmlAnchor(event.data)) return;
    // Markdown artifacts keep their source-line estimate; HTML artifacts keep
    // the element path the bridge computed inside the sandbox.
    const lines = model.artifact?.format === "md" ? estimateLineRange(event.data.selection || "") : {};
    model.pendingHtmlAnchor = {
      selection: event.data.selection || undefined,
      css_path: model.artifact?.format === "md" ? undefined : (event.data.css_path || undefined),
      heading_path: event.data.heading_path || [],
      ...lines,
    };
    const parts = [];
    if (model.pendingHtmlAnchor.selection) parts.push(`“${model.pendingHtmlAnchor.selection}”`);
    if (model.pendingHtmlAnchor.css_path) parts.push(model.pendingHtmlAnchor.css_path);
    elements.anchorPreview.textContent = parts.join(" · ");
    elements.anchorConfirm.hidden = false;
  }

  function closeAnchorConfirm() {
    elements.anchorConfirm.hidden = true;
    model.pendingHtmlAnchor = null;
  }

  function annotationBody(kind) {
    if (kind === "comment") return window.prompt("Comment")?.trim() || null;
    if (kind === "label") return window.prompt("Label")?.trim() || null;
    return undefined;
  }

  function addAnnotation(kind, anchor) {
    if (!anchor || !model.artifactPath || !isCurrentStageArtifact(model.artifactPath)) return;
    const body = annotationBody(kind);
    if ((kind === "comment" || kind === "label") && !body) return;
    const annotation = {
      artifact: basename(model.artifactPath),
      kind,
      heading_path: Array.isArray(anchor.heading_path) ? anchor.heading_path : [],
    };
    for (const field of ["selection", "line_start", "line_end", "css_path"]) {
      if (anchor[field] !== undefined) annotation[field] = anchor[field];
    }
    if (body) annotation.body = body;
    model.annotations.push(annotation);
    persistAnnotations();
    renderAnnotations();
    elements.feedbackBanner.hidden = true;
  }

  function renderAnnotations() {
    elements.annotationList.replaceChildren();
    model.annotations.forEach((annotation, index) => {
      const item = document.createElement("li");
      const heading = document.createElement("div");
      const detail = document.createElement("p");
      const remove = document.createElement("button");
      heading.className = "annotation-heading";
      heading.textContent = `${KIND_LABELS[annotation.kind] || annotation.kind} · ${annotation.artifact}`;
      const location = annotation.heading_path?.join(" › ");
      detail.textContent =
        annotation.body ||
        annotation.selection ||
        location ||
        annotation.css_path ||
        (annotation.kind === "edit" ? "Edited source" : "Artifact-level feedback");
      remove.type = "button";
      remove.className = "remove-annotation";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${KIND_LABELS[annotation.kind] || annotation.kind}`);
      remove.addEventListener("click", () => {
        model.annotations.splice(index, 1);
        persistAnnotations();
        renderAnnotations();
      });
      item.append(heading, detail, remove);
      elements.annotationList.append(item);
    });
    const hasFeedback = model.annotations.length > 0 || elements.generalNotes.value.trim().length > 0;
    elements.feedbackEmpty.hidden = model.annotations.length > 0;
    elements.sendFeedbackButton.disabled = !hasFeedback || !model.state?.current?.stage;
  }

  function openEditor() {
    if (model.artifact?.format !== "md") return;
    closeDiff();
    elements.sourceEditor.value = model.artifact.source;
    elements.viewer.hidden = true;
    elements.editorPanel.hidden = false;
    elements.sourceEditor.focus();
  }

  function closeEditor() {
    elements.editorPanel.hidden = true;
    elements.viewer.hidden = false;
  }

  function addEditAnnotation() {
    if (!model.artifact || elements.sourceEditor.value === model.artifact.source) {
      showNotice("Change the source before adding an edit.");
      return;
    }
    model.annotations.push({
      artifact: basename(model.artifactPath),
      kind: "edit",
      heading_path: [],
      after: elements.sourceEditor.value,
    });
    persistAnnotations();
    renderAnnotations();
    elements.feedbackBanner.hidden = true;
    closeEditor();
  }

  async function openRevisionPicker() {
    const stageDir = model.state?.current?.stage_dir;
    if (!stageDir || !model.artifactPath) return;
    try {
      const result = await requestJson(apiUrl("/api/snapshots", { stage_dir: stageDir }));
      elements.revisionSelect.replaceChildren();
      for (const revision of result.revisions || []) {
        const option = document.createElement("option");
        option.value = String(revision);
        option.textContent = `Revision ${revision}`;
        elements.revisionSelect.append(option);
      }
      if (!elements.revisionSelect.options.length) {
        showNotice("No saved revisions are available for this stage.", "info");
        return;
      }
      elements.revisionDialog.showModal();
    } catch (error) {
      showNotice(`Could not load revisions: ${error.message}`);
    }
  }

  async function showDiff() {
    if (!model.artifactPath) return;
    const revision = elements.revisionSelect.value;
    elements.revisionDialog.close();
    closeEditor();
    elements.diffPanel.hidden = false;
    elements.viewer.hidden = true;
    elements.diffTitle.textContent = `${basename(model.artifactPath)} · revision ${revision} → current`;
    elements.diffOutput.textContent = "Loading diff…";
    try {
      const result = await requestJson(
        apiUrl("/api/diff", { path: model.artifactPath, from: revision, to: "current" }),
      );
      renderUnifiedDiff(result.unified || "No changes.");
    } catch (error) {
      elements.diffOutput.textContent = `Could not load diff: ${error.message}`;
    }
  }

  function renderUnifiedDiff(unified) {
    elements.diffOutput.replaceChildren();
    for (const line of String(unified).split("\n")) {
      const row = document.createElement("span");
      row.className = "diff-line";
      if (line.startsWith("+") && !line.startsWith("+++")) row.classList.add("addition");
      else if (line.startsWith("-") && !line.startsWith("---")) row.classList.add("deletion");
      else if (line.startsWith("@@")) row.classList.add("hunk");
      row.textContent = line || " ";
      elements.diffOutput.append(row);
    }
  }

  function closeDiff() {
    elements.diffPanel.hidden = true;
    if (elements.editorPanel.hidden) elements.viewer.hidden = false;
  }

  async function sendFeedback() {
    const current = model.state?.current;
    if (!current?.stage) return;
    const general = elements.generalNotes.value.trim();
    const body = {
      stage: current.stage,
      unit: current.unit ?? null,
      revision: current.revision,
      decision_hint: decisionHint(),
      annotations: model.annotations,
    };
    if (general) body.general = general;

    elements.sendFeedbackButton.disabled = true;
    elements.sendFeedbackButton.textContent = "Sending…";
    clearNotice();
    try {
      const result = await requestJson("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      model.annotations = [];
      persistAnnotations();
      elements.generalNotes.value = "";
      renderAnnotations();
      elements.feedbackBanner.textContent = `Saved as ${result.file}. Return to the terminal and answer the approval question.`;
      elements.feedbackBanner.hidden = false;
    } catch (error) {
      showNotice(`Could not send feedback: ${error.message}`);
      renderAnnotations();
    } finally {
      elements.sendFeedbackButton.textContent = "Send feedback";
    }
  }

  async function refreshTree() {
    try {
      const result = await requestJson("/api/tree");
      renderTree(result.entries || []);
    } catch (error) {
      elements.recordTree.textContent = `Could not load record: ${error.message}`;
    }
  }

  function renderTree(entries) {
    const root = { name: "", path: "", type: "dir", children: new Map() };
    for (const entry of entries) {
      const segments = String(entry.path || "").split("/").filter(Boolean);
      let parent = root;
      segments.forEach((segment, index) => {
        const path = segments.slice(0, index + 1).join("/");
        if (!parent.children.has(segment)) {
          parent.children.set(segment, {
            name: segment,
            path,
            type: index === segments.length - 1 ? entry.type : "dir",
            size: entry.size,
            children: new Map(),
          });
        }
        parent = parent.children.get(segment);
        if (index === segments.length - 1) Object.assign(parent, entry, { name: segment, path });
      });
    }

    elements.recordTree.className = "record-tree";
    elements.recordTree.replaceChildren(renderTreeChildren(root));
  }

  function renderTreeChildren(node) {
    const list = document.createElement("ul");
    const children = [...node.children.values()].sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of children) {
      const item = document.createElement("li");
      if (child.type === "dir") {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = child.name;
        if (node === undefined || node.path === "") details.open = true;
        details.append(summary, renderTreeChildren(child));
        item.append(details);
      } else {
        const canOpen = /\.(?:md|html?)$/i.test(child.name);
        if (canOpen) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = child.name;
          button.title = child.path;
          button.addEventListener("click", () => openArtifact(child.path));
          item.append(button);
        } else {
          const label = document.createElement("span");
          label.textContent = child.name;
          label.title = child.path;
          item.append(label);
        }
      }
      list.append(item);
    }
    return list;
  }

  function connectSocket() {
    clearTimeout(model.socketTimer);
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${window.location.host}/ws`);
    socket.addEventListener("open", () => {
      model.socketRetry = 0;
      elements.pausedOverlay.textContent = PAUSED_RECONNECTING;
      elements.pausedOverlay.classList.add("connected");
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message?.type === "state") Promise.all([refreshState(), refreshTree()]);
      } catch {
        // Ignore messages outside the daemon's tiny state-notification protocol.
      }
    });
    const reconnect = async () => {
      if (socket.readyState === WebSocket.OPEN) socket.close();
      elements.pausedOverlay.classList.remove("connected");
      // Tell the human why the socket dropped: a lapsed session (401) and a
      // stopped daemon (network error) need different actions from them.
      try {
        const probe = await fetch("/api/state", { cache: "no-store" });
        if (probe.status === 401) sessionLost();
        else showPaused(PAUSED_RECONNECTING);
      } catch {
        showPaused(PAUSED_DAEMON_DOWN);
      }
      const delay = Math.min(15_000, 500 * 2 ** model.socketRetry++);
      model.socketTimer = window.setTimeout(connectSocket, delay);
    };
    socket.addEventListener("close", reconnect, { once: true });
    socket.addEventListener("error", () => socket.close());
  }

  elements.selectionToolbar.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-kind]");
    if (!button) return;
    const anchor = model.selectionAnchor;
    addAnnotation(button.dataset.kind, anchor);
    window.getSelection()?.removeAllRanges();
    closeSelectionToolbar();
  });

  elements.anchorConfirm.addEventListener("click", (event) => {
    const dismiss = event.target.closest("button[data-dismiss]");
    if (dismiss) {
      closeAnchorConfirm();
      return;
    }
    const button = event.target.closest("button[data-kind]");
    if (!button) return;
    const anchor = model.pendingHtmlAnchor;
    addAnnotation(button.dataset.kind, anchor);
    closeAnchorConfirm();
  });

  elements.globalCommentButton.addEventListener("click", () => {
    addAnnotation("comment", { heading_path: [] });
  });
  elements.editButton.addEventListener("click", openEditor);
  elements.cancelEditButton.addEventListener("click", closeEditor);
  elements.addEditButton.addEventListener("click", addEditAnnotation);
  elements.exportButton.addEventListener("click", () => {
    if (model.artifactPath) window.location.assign(apiUrl("/api/export", { path: model.artifactPath }));
  });
  elements.diffButton.addEventListener("click", openRevisionPicker);
  elements.showDiffButton.addEventListener("click", (event) => {
    event.preventDefault();
    showDiff();
  });
  elements.closeDiffButton.addEventListener("click", closeDiff);
  elements.generalNotes.addEventListener("input", renderAnnotations);
  elements.sendFeedbackButton.addEventListener("click", sendFeedback);
  elements.questionsButton.addEventListener("click", openQuestions);
  elements.questionsForm.addEventListener("submit", saveQuestionAnswers);
  elements.questionsForm.addEventListener("input", syncQuestionForm);
  elements.questionsForm.addEventListener("change", syncQuestionForm);
  elements.viewer.addEventListener("mouseup", handleMarkdownSelection);
  window.addEventListener("message", receiveHtmlAnchor);
  window.addEventListener("message", receiveGuideRecommendations);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSelectionToolbar();
      closeAnchorConfirm();
    }
  });

  renderAnnotations();
  refreshState();
  refreshTree();
  connectSocket();
})();
