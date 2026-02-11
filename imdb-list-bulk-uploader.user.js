// ==UserScript==
// @name         IMDb List Bulk Uploader
// @namespace    https://github.com/BonaFideBOSS/imdb-list-bulk-uploader
// @version      1.0.0
// @description  Bulk add titles to an IMDb list from CSV data or file upload, with optional descriptions and rate-limit delay.
// @author       Amaan Al Mir
// @match        https://www.imdb.com/list/ls*/edit*
// @icon         https://www.imdb.com/favicon.ico
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const GRAPHQL_ENDPOINT = "https://api.graphql.imdb.com/";

  const DELAY_OPTIONS = [
    { label: "5 s", value: 5000 },
    { label: "10 s", value: 10000 },
    { label: "15 s", value: 15000 },
    { label: "30 s", value: 30000 },
  ];

  const MUTATIONS = {
    addItem: `mutation AddConstToList($listId: ID!, $constId: ID!) {
  addItemToList(input: {listId: $listId, item: {itemElementId: $constId}}) {
    listId
    modifiedItem {
      itemId
      description {
        originalText { plainText }
      }
      listItem {
        ... on Title { id titleText { text } }
        ... on Name  { id nameText  { text } }
      }
    }
  }
}`,

    editDescription: `mutation EditListItemDescription($listId: ID!, $itemId: ID!, $itemDescription: String!) {
  editListItemDescription(
    input: {listId: $listId, itemId: $itemId, itemDescription: $itemDescription}
  ) {
    formattedItemDescription {
      originalText { plainText }
    }
  }
}`,
  };

  // ---------------------------------------------------------------------------
  // Helpers – Page context
  // ---------------------------------------------------------------------------

  /** Extract the list ID from the current URL. */
  function getListId() {
    const match = window.location.pathname.match(/(ls\d+)/);
    return match ? match[1] : null;
  }

  /** Build the common headers IMDb's front-end sends with every GraphQL call. */
  function buildHeaders() {
    const cookie = (name) =>
      document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1] ??
      "";

    return {
      accept: "application/graphql+json, application/json",
      "content-type": "application/json",
      "x-amzn-sessionid": cookie("session-id"),
      "x-imdb-client-name": "imdb-web-next-localized",
      "x-imdb-user-language": navigator.language || "en-US",
      "x-imdb-consent-info": cookie("ci"),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers – CSV parsing
  // ---------------------------------------------------------------------------

  /**
   * Parse raw text (CSV or plain IDs) into an array of {id, description}.
   *
   * Supported formats
   * -----------------
   * 1. `id,description` header row followed by data rows
   * 2. Plain list of IDs (one per line, no header)
   * 3. Mix – rows with or without the description column
   */
  function parseInput(raw) {
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) return [];

    // Detect whether the first line is a header row.
    const firstLine = lines[0].toLowerCase();
    const hasHeader =
      firstLine === "id" ||
      firstLine === "id,description" ||
      firstLine.startsWith("id,");
    const dataLines = hasHeader ? lines.slice(1) : lines;

    return dataLines.map(parseLine).filter((entry) => entry !== null);
  }

  /**
   * Parse a single CSV line, respecting quoted fields.
   * Returns {id, description} or null if the line is invalid.
   */
  function parseLine(line) {
    const fields = splitCSVLine(line);
    const id = fields[0]?.trim();
    if (!id) return null;

    const description = fields.length > 1 ? fields[1]?.trim() : "";
    return { id, description };
  }

  /** Splits a CSV line by comma while respecting double-quoted fields. */
  function splitCSVLine(line) {
    const fields = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current);
    return fields;
  }

  // ---------------------------------------------------------------------------
  // GraphQL API calls
  // ---------------------------------------------------------------------------

  async function addItemToList(listId, constId) {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: buildHeaders(),
      body: JSON.stringify({
        query: MUTATIONS.addItem,
        operationName: "AddConstToList",
        variables: { listId, constId },
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} – ${res.statusText}`);
    }

    const json = await res.json();
    if (json.errors?.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }

    return json.data.addItemToList.modifiedItem;
  }

  async function updateDescription(listId, itemId, description) {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: buildHeaders(),
      body: JSON.stringify({
        query: MUTATIONS.editDescription,
        operationName: "EditListItemDescription",
        variables: { listId, itemId, itemDescription: description },
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} – ${res.statusText}`);
    }

    const json = await res.json();
    if (json.errors?.length) {
      throw new Error(json.errors.map((e) => e.message).join("; "));
    }

    return json.data.editListItemDescription;
  }

  // ---------------------------------------------------------------------------
  // Bulk upload orchestrator
  // ---------------------------------------------------------------------------

  /**
   * Process a list of items sequentially.
   *
   * @param {Array<{id:string, description:string}>} items
   * @param {object}  opts
   * @param {boolean} opts.useDelay
   * @param {number}  opts.delayMs
   * @param {function} opts.onProgress  Called after each item with (index, total, status).
   * @param {function} opts.getAborted  Returns true when the user has cancelled.
   */
  async function processItems(
    items,
    { useDelay, delayMs, onProgress, getAborted },
  ) {
    const listId = getListId();
    if (!listId) throw new Error("Could not determine list ID from URL.");

    const results = [];

    for (let i = 0; i < items.length; i++) {
      if (getAborted()) break;

      const item = items[i];
      const status = {
        id: item.id,
        index: i,
        ok: false,
        error: null,
        title: "",
      };

      try {
        // Step 1 – add the item
        const added = await addItemToList(listId, item.id);
        const titleNode = added?.listItem;
        status.title =
          titleNode?.titleText?.text || titleNode?.nameText?.text || item.id;

        // Step 2 – update description (if provided)
        if (item.description) {
          const itemId = added?.itemId;
          if (itemId) {
            await updateDescription(listId, itemId, item.description);
          }
        }

        status.ok = true;
      } catch (err) {
        status.error = err.message;
      }

      results.push(status);
      onProgress(i + 1, items.length, status);

      // Delay between items (skip after the last item)
      if (useDelay && i < items.length - 1 && !getAborted()) {
        await sleep(delayMs);
      }
    }

    return results;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---------------------------------------------------------------------------
  // CSV template download
  // ---------------------------------------------------------------------------

  function downloadTemplate() {
    const csv = 'id,description\ntt0111161,"Your description here"';
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "imdb_bulk_upload_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  /** Find the "Add a title to this list" container using stable selectors. */
  function findAddTitleSection() {
    // Primary: stable data-testid on the autocomplete input
    const input = document.querySelector(
      '[data-testid="entity-autocomplete-input"]',
    );
    if (input) {
      // Walk up to the section-level container that wraps the label + input
      let el = input;
      while (el && el.parentElement) {
        el = el.parentElement;
        // The wrapper is the first direct child of the page-section that contains the input
        if (el.parentElement?.classList?.contains("list_page_mc_parent"))
          return el;
      }
    }

    // Fallback: find by label text
    const allDivs = document.querySelectorAll("div");
    for (const div of allDivs) {
      if (
        div.textContent.includes("Add a title to this list") &&
        div.querySelector('input[placeholder="Search title to add"]') &&
        div.parentElement?.tagName === "SECTION"
      ) {
        return div;
      }
    }

    return null;
  }

  function injectUI() {
    const anchorSection = findAddTitleSection();
    if (!anchorSection) {
      console.warn(
        "[IMDb Bulk Uploader] Could not find the add-title section.",
      );
      return;
    }

    // State
    let aborted = false;
    let running = false;

    // ---- Root card ----
    const card = el("div", { className: "bulk-uploader-card" });

    // ---- Header ----
    const header = el("div", { className: "bu-header" }, [
      el("div", { className: "bu-header-left" }, [
        el("svg", {
          innerHTML: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
        }),
        el("span", { textContent: "Bulk Upload", className: "bu-title" }),
      ]),
      el("button", {
        textContent: "Download CSV Template",
        className: "bu-link-btn",
        onclick: downloadTemplate,
      }),
    ]);

    // ---- Tabs ----
    let activeTab = "textarea";

    const tabTextarea = el("button", {
      textContent: "Paste Data",
      className: "bu-tab bu-tab-active",
      onclick: () => switchTab("textarea"),
    });
    const tabFile = el("button", {
      textContent: "Upload CSV",
      className: "bu-tab",
      onclick: () => switchTab("file"),
    });
    const tabBar = el("div", { className: "bu-tabs" }, [tabTextarea, tabFile]);

    // ---- Textarea panel ----
    const textarea = el("textarea", {
      className: "bu-textarea",
      placeholder:
        'id,description\ntt0111161,"Your description here"\ntt0068646\ntt0468569,"Another description"',
      spellcheck: false,
    });
    const textareaPanel = el("div", { className: "bu-panel" }, [textarea]);

    // ---- File panel ----
    const fileInput = el("input", {
      type: "file",
      accept: ".csv,.txt",
      className: "bu-file-input",
    });
    const fileLabel = el("label", { className: "bu-file-label" }, [
      el("span", {
        innerHTML: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
      }),
      el("span", {
        textContent: "Click to choose a CSV file",
        className: "bu-file-text",
      }),
    ]);
    const filePanel = el("div", { className: "bu-panel bu-panel-hidden" }, [
      fileInput,
      fileLabel,
    ]);

    fileInput.addEventListener("change", () => {
      if (fileInput.files.length) {
        fileLabel.querySelector(".bu-file-text").textContent =
          fileInput.files[0].name;
      }
    });

    function switchTab(tab) {
      activeTab = tab;
      tabTextarea.classList.toggle("bu-tab-active", tab === "textarea");
      tabFile.classList.toggle("bu-tab-active", tab === "file");
      textareaPanel.classList.toggle("bu-panel-hidden", tab !== "textarea");
      filePanel.classList.toggle("bu-panel-hidden", tab !== "file");
    }

    // ---- Options row ----
    const delayCheckbox = el("input", {
      type: "checkbox",
      id: "bu-delay-toggle",
    });
    const delaySelect = el("select", {
      className: "bu-select",
      disabled: true,
    });
    DELAY_OPTIONS.forEach((opt) => {
      const o = el("option", { value: opt.value, textContent: opt.label });
      delaySelect.appendChild(o);
    });
    delayCheckbox.addEventListener("change", () => {
      delaySelect.disabled = !delayCheckbox.checked;
    });

    const optionsRow = el("div", { className: "bu-options" }, [
      el("label", { className: "bu-delay-label" }, [
        delayCheckbox,
        el("span", { textContent: "Delay between requests" }),
      ]),
      delaySelect,
    ]);

    // ---- Action buttons ----
    const startBtn = el("button", {
      textContent: "Start Upload",
      className: "bu-btn bu-btn-primary",
    });
    const cancelBtn = el("button", {
      textContent: "Cancel",
      className: "bu-btn bu-btn-cancel bu-hidden",
    });

    const actionRow = el("div", { className: "bu-actions" }, [
      startBtn,
      cancelBtn,
    ]);

    // ---- Progress area ----
    const progressContainer = el("div", { className: "bu-progress bu-hidden" });
    const progressBar = el("div", { className: "bu-progress-bar" });
    const progressTrack = el("div", { className: "bu-progress-track" }, [
      progressBar,
    ]);
    const progressText = el("span", { className: "bu-progress-text" });
    const progressHead = el("div", { className: "bu-progress-head" }, [
      progressTrack,
      progressText,
    ]);

    const logList = el("div", { className: "bu-log" });
    progressContainer.append(progressHead, logList);

    // ---- Assemble ----
    card.append(
      header,
      tabBar,
      textareaPanel,
      filePanel,
      optionsRow,
      actionRow,
      progressContainer,
    );
    anchorSection.parentElement.insertBefore(card, anchorSection);

    // ---- Start handler ----
    startBtn.addEventListener("click", async () => {
      if (running) return;

      // Read input
      let raw = "";
      if (activeTab === "textarea") {
        raw = textarea.value;
      } else {
        const file = fileInput.files[0];
        if (!file) {
          showLog(logList, "No file selected.", "error");
          return;
        }
        raw = await file.text();
      }

      const items = parseInput(raw);
      if (items.length === 0) {
        showLog(
          logList,
          "No valid items found. Check your input format.",
          "error",
        );
        return;
      }

      // Reset UI
      running = true;
      aborted = false;
      logList.innerHTML = "";
      progressContainer.classList.remove("bu-hidden");
      cancelBtn.classList.remove("bu-hidden");
      startBtn.disabled = true;
      startBtn.textContent = "Uploading…";
      progressBar.style.width = "0%";
      progressText.textContent = `0 / ${items.length}`;

      showLog(logList, `Starting upload of ${items.length} item(s)…`, "info");

      const opts = {
        useDelay: delayCheckbox.checked,
        delayMs: parseInt(delaySelect.value, 10),
        getAborted: () => aborted,
        onProgress: (done, total, status) => {
          const pct = Math.round((done / total) * 100);
          progressBar.style.width = `${pct}%`;
          progressText.textContent = `${done} / ${total}`;

          if (status.ok) {
            showLog(
              logList,
              `[${done}/${total}] Added ${status.title} (${status.id})`,
              "success",
            );
          } else {
            showLog(
              logList,
              `[${done}/${total}] Failed ${status.id}: ${status.error}`,
              "error",
            );
          }
        },
      };

      try {
        const results = await processItems(items, opts);
        const succeeded = results.filter((r) => r.ok).length;
        const failed = results.filter((r) => !r.ok).length;
        const msg = aborted
          ? `Upload cancelled. ${succeeded} added, ${failed} failed.`
          : `Upload complete! ${succeeded} added, ${failed} failed.`;
        showLog(logList, msg, aborted ? "warn" : "info");
      } catch (err) {
        showLog(logList, `Unexpected error: ${err.message}`, "error");
      }

      running = false;
      startBtn.disabled = false;
      startBtn.textContent = "Start Upload";
      cancelBtn.classList.add("bu-hidden");
    });

    cancelBtn.addEventListener("click", () => {
      aborted = true;
      cancelBtn.classList.add("bu-hidden");
      showLog(logList, "Cancelling… will stop after current item.", "warn");
    });

    // ---- Inject styles ----
    injectStyles();
  }

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------

  /** Tiny DOM helper. */
  function el(tag, props = {}, children = []) {
    const node =
      tag === "svg"
        ? document.createRange().createContextualFragment(props.innerHTML || "")
            .firstElementChild
        : document.createElement(tag);

    if (tag !== "svg") {
      Object.entries(props).forEach(([k, v]) => {
        if (k === "className") node.className = v;
        else if (k === "innerHTML") node.innerHTML = v;
        else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
        else if (k in node) node[k] = v;
        else node.setAttribute(k, v);
      });
    }

    children.forEach((c) => {
      if (typeof c === "string") node.appendChild(document.createTextNode(c));
      else if (c) node.appendChild(c);
    });

    return node;
  }

  function showLog(container, message, type = "info") {
    const colors = {
      info: "#f5c518",
      success: "#4caf50",
      error: "#f44336",
      warn: "#ff9800",
    };

    const line = el("div", { className: `bu-log-line bu-log-${type}` }, [
      el("span", {
        className: "bu-log-dot",
        style: `background:${colors[type]};`,
      }),
      el("span", { textContent: message }),
    ]);

    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
  }

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  function injectStyles() {
    if (document.getElementById("bu-styles")) return;

    const css = `
      .bulk-uploader-card {
        background: rgb(250, 250, 250);
        border: 1px solid rgba(0,0,0,0.12);
        border-radius: 8px;
        padding: 20px 24px 24px;
        margin-bottom: 16px;
        font-family: Roboto, Helvetica, Arial, sans-serif;
        color: rgba(0,0,0,0.87);
      }

      /* Header */
      .bu-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 16px;
      }
      .bu-header-left {
        display: flex;
        align-items: center;
        gap: 8px;
        color: rgba(0,0,0,0.7);
      }
      .bu-title {
        font-size: 16px;
        font-weight: 700;
        color: rgba(0,0,0,0.54);
      }
      .bu-link-btn {
        background: none;
        border: none;
        color: #f5c518;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        padding: 4px 0;
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .bu-link-btn:hover { color: #e0b400; }

      /* Tabs */
      .bu-tabs {
        display: flex;
        gap: 0;
        margin-bottom: 12px;
        border-bottom: 2px solid rgba(0,0,0,0.08);
      }
      .bu-tab {
        flex: 1;
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        margin-bottom: -2px;
        padding: 8px 0;
        font-size: 14px;
        font-weight: 600;
        color: rgba(0,0,0,0.38);
        cursor: pointer;
        transition: color 0.15s, border-color 0.15s;
      }
      .bu-tab:hover { color: rgba(0,0,0,0.54); }
      .bu-tab-active {
        color: #f5c518;
        border-bottom-color: #f5c518;
      }

      /* Panels */
      .bu-panel { margin-bottom: 12px; }
      .bu-panel-hidden { display: none; }

      .bu-textarea {
        width: 100%;
        min-height: 120px;
        padding: 12px;
        border: 1px solid rgba(0,0,0,0.25);
        border-radius: 4px;
        background: #fff;
        color: rgba(0,0,0,0.7);
        font-family: 'Roboto Mono', monospace;
        font-size: 13px;
        line-height: 1.5;
        resize: vertical;
        box-sizing: border-box;
        outline: none;
        transition: border-color 0.15s;
      }
      .bu-textarea:focus { border-color: #f5c518; }
      .bu-textarea::placeholder { color: rgba(0,0,0,0.25); }

      /* File upload */
      .bu-file-input {
        position: absolute;
        width: 0;
        height: 0;
        opacity: 0;
        pointer-events: none;
      }
      .bu-file-label {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        min-height: 120px;
        border: 2px dashed rgba(0,0,0,0.18);
        border-radius: 4px;
        cursor: pointer;
        color: rgba(0,0,0,0.38);
        transition: border-color 0.15s, color 0.15s;
      }
      .bu-file-label:hover {
        border-color: #f5c518;
        color: #f5c518;
      }
      .bu-file-text { font-size: 14px; }

      /* Options */
      .bu-options {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 16px;
      }
      .bu-delay-label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        color: rgba(0,0,0,0.6);
        cursor: pointer;
        user-select: none;
      }
      .bu-delay-label input[type="checkbox"] {
        accent-color: #f5c518;
        width: 16px;
        height: 16px;
        cursor: pointer;
      }
      .bu-select {
        padding: 4px 8px;
        border: 1px solid rgba(0,0,0,0.25);
        border-radius: 4px;
        font-size: 13px;
        background: #fff;
        color: rgba(0,0,0,0.7);
        outline: none;
        cursor: pointer;
      }
      .bu-select:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      /* Buttons */
      .bu-actions {
        display: flex;
        gap: 10px;
        margin-bottom: 4px;
      }
      .bu-btn {
        padding: 8px 24px;
        border: none;
        border-radius: 4px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s, opacity 0.15s;
      }
      .bu-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .bu-btn-primary {
        background: #f5c518;
        color: #000;
      }
      .bu-btn-primary:hover:not(:disabled) { background: #e0b400; }
      .bu-btn-cancel {
        background: rgba(0,0,0,0.08);
        color: rgba(0,0,0,0.6);
      }
      .bu-btn-cancel:hover { background: rgba(0,0,0,0.14); }
      .bu-hidden { display: none !important; }

      /* Progress */
      .bu-progress { margin-top: 16px; }
      .bu-progress-head {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 8px;
      }
      .bu-progress-track {
        flex: 1;
        height: 6px;
        background: rgba(0,0,0,0.08);
        border-radius: 3px;
        overflow: hidden;
      }
      .bu-progress-bar {
        height: 100%;
        width: 0%;
        background: #f5c518;
        border-radius: 3px;
        transition: width 0.3s ease;
      }
      .bu-progress-text {
        font-size: 13px;
        font-weight: 600;
        color: rgba(0,0,0,0.54);
        white-space: nowrap;
        min-width: 60px;
        text-align: right;
      }

      /* Log */
      .bu-log {
        max-height: 200px;
        overflow-y: auto;
        padding: 8px 0 0;
        font-size: 13px;
        line-height: 1.6;
      }
      .bu-log-line {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 2px 0;
      }
      .bu-log-dot {
        flex-shrink: 0;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        margin-top: 5px;
      }
      .bu-log-success { color: rgba(0,0,0,0.7); }
      .bu-log-error   { color: #d32f2f; }
      .bu-log-warn    { color: #e65100; }
      .bu-log-info    { color: rgba(0,0,0,0.54); }
    `;

    const style = document.createElement("style");
    style.id = "bu-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  /** Wait for the target section to exist, then inject. */
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);

      const observer = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error("Timeout waiting for element: " + selector));
      }, timeout);
    });
  }

  waitForElement('[data-testid="entity-autocomplete-input"]')
    .then(injectUI)
    .catch(console.error);
})();
