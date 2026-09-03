(() => {
  "use strict";

  function safeText(value, limit) {
    return String(value || "").trim().slice(0, limit);
  }

  function elementForSelection(selection) {
    if (!selection || !selection.rangeCount) return null;
    const node = selection.getRangeAt(0).commonAncestorContainer;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function cssPath(element) {
    if (!(element instanceof Element)) return undefined;
    const segments = [];
    let current = element;
    while (current && current !== document.documentElement) {
      let segment = current.tagName.toLowerCase();
      if (current.id) {
        const escaped = window.CSS?.escape ? window.CSS.escape(current.id) : current.id.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
        segment += `#${escaped}`;
        segments.unshift(segment);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        segment += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      segments.unshift(segment);
      current = parent;
    }
    return safeText(segments.join(" > "), 500) || undefined;
  }

  function headingPath(element) {
    if (!(element instanceof Element)) return [];
    const path = [];
    const headings = document.querySelectorAll("h1,h2,h3");
    for (const heading of headings) {
      if (!(heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const level = Number(heading.tagName.slice(1));
      path.length = level - 1;
      path[level - 1] = safeText(heading.textContent, 240);
    }
    return path.filter(Boolean).slice(-12);
  }

  function postAnchor(element, selectedText) {
    if (window.parent === window) return;
    const selection = safeText(selectedText, 4000);
    const path = cssPath(element);
    if (!selection && !path) return;
    const payload = {
      type: "aidlc-anchor",
      css_path: path,
      heading_path: headingPath(element),
    };
    if (selection) payload.selection = selection;
    window.parent.postMessage(payload, "*");
  }

  document.addEventListener("mouseup", (event) => {
    if (!event.isTrusted) return;
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (!text) return;
    postAnchor(elementForSelection(selection), text);
  });

  document.addEventListener("click", (event) => {
    if (!event.isTrusted || !event.altKey) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    postAnchor(target, "");
  });
})();
