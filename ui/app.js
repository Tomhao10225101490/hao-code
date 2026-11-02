// hao-code app UI client — vanilla JS, no build step, no dependencies.
//
// Talks to the local app server: GET /api/config and /api/sessions for the
// sidebar, POST /api/turn (Server-Sent Events) for a chat turn, and
// POST /api/approve to answer permission cards.

"use strict";

const $ = (id) => document.getElementById(id);

const messagesEl = $("messages");
const changesEl = $("changesList");
const composerEl = $("composer");
const sendBtn = $("sendBtn");
const statusEl = $("statusLine");
const traceToggle = $("traceToggle");

const state = {
  running: false,
  trace: true,
  /** The assistant bubble currently receiving streamed tokens. */
  currentTextBody: null,
  /** Tool cards of this turn, in call order (results complete in order). */
  cards: [],
  /** Per-turn counters for the end-of-turn panel. */
  toolCalls: 0,
  filesChanged: [],
  lastStepAt: 0,
  pendingApprovals: 0,
};

function make(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function hideEmptyState() {
  const empty = $("emptyState");
  if (empty) empty.remove();
}

function setStatus(text) {
  statusEl.textContent = text;
}

function formatCount(n) {
  return n === undefined || n === null ? "?" : Number(n).toLocaleString("en-US");
}

/* ------------------------------------------------------------------ */
/* Conversation pieces                                                 */
/* ------------------------------------------------------------------ */

function addUserBubble(text) {
  hideEmptyState();
  const wrap = make("div", "msg user");
  const bubble = make("div", "bubble", text);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

function startAssistantText() {
  hideEmptyState();
  const wrap = make("div", "msg assistant");
  wrap.appendChild(make("div", "who", "hao-code"));
  const bubble = make("div", "bubble");
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  state.currentTextBody = bubble;
  return bubble;
}

function appendToken(text) {
  if (!state.currentTextBody) startAssistantText();
  state.currentTextBody.textContent += text;
  scrollToBottom();
}

function closeAssistantText() {
  state.currentTextBody = null;
}

function addStepHeader(step) {
  if (!state.trace) return;
  const now = Date.now();
  const elapsed = state.lastStepAt ? now - state.lastStepAt : 0;
  state.lastStepAt = now;
  const label =
    elapsed > 0 ? `step ${step} · ${(elapsed / 1000).toFixed(1)}s` : `step ${step}`;
  messagesEl.appendChild(make("div", "step-header", label));
}

function addNotice(text, cls) {
  messagesEl.appendChild(make("div", cls || "notice", text));
}

function addError(text) {
  messagesEl.appendChild(make("div", "error-line", `Error: ${text}`));
}

/** Render a unified diff as colored lines. Returns the diff element. */
function renderDiff(diffText) {
  const root = make("div", "diff");
  for (const line of diffText.replace(/\n$/, "").split("\n")) {
    let cls = "ctx";
    if (line.startsWith("+++") || line.startsWith("---")) cls = "meta";
    else if (line.startsWith("+")) cls = "add";
    else if (line.startsWith("-")) cls = "del";
    else if (line.startsWith("@@")) cls = "hunk";
    root.appendChild(make("div", `diff-line ${cls}`, line === "" ? " " : line));
  }
  return root;
}

function addToolCard(ev) {
  hideEmptyState();
  const card = {
    name: ev.name,
    args: ev.args || {},
    diff: ev.diff || null,
    done: false,
    body: null,
    root: null,
  };

  const root = make("div", "tool-card");
  card.root = root;
  const head = make("div", "tool-card-head");
  const status = make("span", "tool-status");
  status.dataset.role = "status";
  head.appendChild(status);
  head.appendChild(make("span", "tool-name", ev.name));
  head.appendChild(make("span", "tool-chevron", "▸ details"));
  const body = make("div", "tool-card-body");
  card.body = body;

  body.appendChild(make("div", "tool-section-label", "Arguments"));
  const argsPre = make("pre", "tool-args", JSON.stringify(card.args, null, 2));
  body.appendChild(argsPre);
  if (card.diff) {
    body.appendChild(make("div", "tool-section-label", "Diff"));
    body.appendChild(renderDiff(card.diff));
  }

  head.addEventListener("click", () => {
    root.classList.toggle("open");
    const chevron = head.querySelector(".tool-chevron");
    if (chevron) {
      chevron.textContent = root.classList.contains("open") ? "▾ details" : "▸ details";
    }
  });

  root.appendChild(head);
  root.appendChild(body);
  messagesEl.appendChild(root);
  state.cards.push(card);
  state.toolCalls += 1;
  scrollToBottom();
  return card;
}

function truncatePreview(text, maxLines) {
  const lines = String(text).split("\n");
  if (lines.length <= maxLines) return text;
  return (
    lines.slice(0, maxLines).join("\n") +
    `\n… (${lines.length - maxLines} more line${lines.length - maxLines === 1 ? "" : "s"})`
  );
}

function completeToolCard(ev) {
  const card = state.cards.find((c) => !c.done);
  if (card) {
    card.done = true;
    const status = card.root.querySelector('[data-role="status"]');
    if (status) status.className = `tool-status ${ev.ok ? "ok" : "err"}`;
    card.body.appendChild(make("div", "tool-section-label", ev.ok ? "Result" : "Result — failed"));
    card.body.appendChild(
      make("pre", "tool-result", truncatePreview(ev.result ?? "", 12)),
    );
    if (ev.ok && card.diff) {
      addChangeEntry(card);
      const p = card.args && card.args.path;
      if (typeof p === "string" && !state.filesChanged.includes(p)) {
        state.filesChanged.push(p);
      }
    } else if (!ev.ok && card.diff && String(ev.result).includes("Permission denied")) {
      addDeniedEntry(card);
    }
    // Open the card on failure so the user sees what happened.
    if (!ev.ok) card.root.classList.add("open");
  }
  scrollToBottom();
}

function addApprovalCard(ev) {
  hideEmptyState();
  state.pendingApprovals += 1;
  setStatus("Waiting for your approval…");

  const root = make("div", "approval-card");
  root.appendChild(make("div", "approval-title", `Allow ${ev.tool}?`));
  root.appendChild(make("pre", "approval-summary", ev.summary || ev.tool));
  if (ev.diff) root.appendChild(renderDiff(ev.diff));

  const buttons = make("div", "approval-buttons");
  const labels = [
    ["y", "Approve", "approve"],
    ["n", "Deny", "deny"],
    ["a", "Always this session", ""],
  ];
  const resolved = make("div", "approval-resolved");
  for (const [answer, label, cls] of labels) {
    const btn = make("button", cls, label);
    btn.type = "button";
    btn.addEventListener("click", async () => {
      for (const b of buttons.querySelectorAll("button")) b.disabled = true;
      try {
        const res = await fetch("/api/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: ev.id, answer }),
        });
        if (!res.ok) throw new Error(`approval failed (${res.status})`);
        resolved.textContent =
          answer === "y"
            ? "✓ Approved"
            : answer === "a"
              ? "✓ Allowed for this session"
              : "✗ Denied";
      } catch (err) {
        resolved.textContent = `Could not send the answer: ${err.message}`;
        for (const b of buttons.querySelectorAll("button")) b.disabled = false;
        return;
      }
      state.pendingApprovals = Math.max(0, state.pendingApprovals - 1);
      if (state.pendingApprovals === 0 && state.running) setStatus("Working…");
      scrollToBottom();
    });
    buttons.appendChild(btn);
  }
  root.appendChild(buttons);
  root.appendChild(resolved);
  messagesEl.appendChild(root);
  scrollToBottom();
}

function addTurnPanel(ev) {
  const parts = [
    `steps: ${ev.steps}`,
    `tool calls: ${state.toolCalls}`,
    `files changed: ${state.filesChanged.length ? state.filesChanged.join(", ") : "none"}`,
  ];
  if (ev.usage) {
    parts.push(
      `tokens: ${formatCount(ev.usage.inputTokens)} in / ${formatCount(ev.usage.outputTokens)} out`,
    );
  }
  messagesEl.appendChild(make("div", "turn-panel", parts.join(" · ")));
}

/* ------------------------------------------------------------------ */
/* Changes pane                                                        */
/* ------------------------------------------------------------------ */

function resetChangesPane() {
  changesEl.textContent = "";
}

function addChangeEntry(card) {
  const entry = make("div", "change-entry");
  const p = card.args && typeof card.args.path === "string" ? card.args.path : card.name;
  entry.appendChild(make("div", "change-path", p));
  entry.appendChild(renderDiff(card.diff));
  changesEl.appendChild(entry);
}

function addDeniedEntry(card) {
  const entry = make("div", "change-entry");
  const p = card.args && typeof card.args.path === "string" ? card.args.path : card.name;
  entry.appendChild(make("div", "change-path", p));
  entry.appendChild(make("div", "change-denied", "change denied — not applied"));
  changesEl.appendChild(entry);
}

/* ------------------------------------------------------------------ */
/* Turn driver                                                         */
/* ------------------------------------------------------------------ */

function handleEvent(ev) {
  switch (ev.type) {
    case "token":
      appendToken(ev.text);
      break;
    case "step":
      closeAssistantText();
      addStepHeader(ev.step);
      break;
    case "tool_call":
      closeAssistantText();
      addToolCard(ev);
      break;
    case "tool_result":
      completeToolCard(ev);
      break;
    case "permission_request":
      addApprovalCard(ev);
      break;
    case "max_steps":
      addNotice(`Stopped: reached the ${ev.steps}-step limit for one turn.`);
      break;
    case "turn_end":
      closeAssistantText();
      addTurnPanel(ev);
      break;
    case "error":
      addError(ev.message || "unknown error");
      break;
    case "done":
      break;
    default:
      break;
  }
  scrollToBottom();
}

function setRunning(running) {
  state.running = running;
  composerEl.disabled = running;
  sendBtn.disabled = running;
  setStatus(running ? "Working…" : "");
  if (!running) composerEl.focus();
}

async function sendTurn(text) {
  state.cards = [];
  state.toolCalls = 0;
  state.filesChanged = [];
  state.lastStepAt = Date.now();
  state.pendingApprovals = 0;
  resetChangesPane();
  addUserBubble(text);
  setRunning(true);

  try {
    const res = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok || !res.body) {
      let detail = `request failed (${res.status})`;
      try {
        const data = await res.json();
        if (data && data.error) detail = data.error;
      } catch {
        /* keep the status-based message */
      }
      throw new Error(detail);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const line = rawEvent.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line.slice("data:".length).trim()));
        } catch {
          /* ignore a malformed event rather than breaking the stream */
        }
      }
    }
  } catch (err) {
    addError(err.message || String(err));
  } finally {
    closeAssistantText();
    setRunning(false);
  }
}

function submitComposer() {
  const text = composerEl.value.trim();
  if (!text || state.running) return;
  composerEl.value = "";
  void sendTurn(text);
}

sendBtn.addEventListener("click", submitComposer);
composerEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitComposer();
  }
});

traceToggle.addEventListener("change", () => {
  state.trace = traceToggle.checked;
});

/* ------------------------------------------------------------------ */
/* Sidebar: config + sessions                                          */
/* ------------------------------------------------------------------ */

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const cfg = await res.json();
    $("versionLabel").textContent = `v${cfg.version}`;
    $("providerBadge").textContent = cfg.provider;
    $("modelLine").textContent = cfg.model;
    $("modelLine").title = cfg.model;
    $("baseUrlLine").textContent = cfg.baseUrl;
    $("baseUrlLine").title = cfg.baseUrl;
    const cwdEl = $("cwdLine");
    cwdEl.textContent = cfg.cwd;
    cwdEl.title = cfg.cwd;
    document.title = `hao-code — ${cfg.model}`;
    state.trace = Boolean(cfg.trace);
    traceToggle.checked = state.trace;
    if (cfg.autoApprove) {
      setStatus("Auto-approve is on in settings — actions will not ask.");
    }
  } catch {
    $("providerBadge").textContent = "offline";
  }
}

async function loadSessions() {
  try {
    const res = await fetch("/api/sessions");
    if (!res.ok) return;
    const data = await res.json();
    const list = $("sessionList");
    list.textContent = "";
    if (!data.sessions || data.sessions.length === 0) {
      list.appendChild(make("li", "session-empty", "No saved sessions yet"));
      return;
    }
    for (const s of data.sessions) {
      const when = s.modified ? new Date(s.modified).toLocaleString() : "";
      const li = make("li", "", s.name.replace(/\.json$/, ""));
      li.title = `${s.name}\n${when}`;
      list.appendChild(li);
    }
  } catch {
    /* the sidebar simply stays empty */
  }
}

void loadConfig();
void loadSessions();
composerEl.focus();
