// Terminal renderer for the agent event stream.
//
// The runtime emits a flat sequence of events (see AgentRuntime.emit). This
// module turns that stream into a live, chat-style CLI: timestamped milestone
// lines, a spinner while the request is being processed or a tool is running, compact
// tool-call / tool-result lines, and a prominent final answer block.
//
// A single Renderer instance is shared across every turn of a conversation so
// spinner state and per-tool timing survive between the model's replies.

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function hms() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function truncate(value, max = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function summarizeArgs(name, args = {}) {
  if (!args || typeof args !== "object") {
    return "";
  }
  if (name === "terminal.exec" || name === "process.start") {
    const program = args.program ?? "";
    const argv = Array.isArray(args.argv) ? args.argv.join(" ") : (args.argv ?? "");
    return truncate(`${program} ${argv}`.trim(), 80);
  }
  if (typeof name === "string" && name.startsWith("fs.")) {
    if (args.path) return truncate(String(args.path), 80);
    if (args.query) return truncate(String(args.query), 80);
    if (args.pattern) return truncate(String(args.pattern), 80);
  }
  if (typeof name === "string" && name.startsWith("process.")) {
    if (args.processId) return truncate(String(args.processId), 80);
    if (args.program) return truncate(String(args.program), 80);
  }
  for (const key of ["path", "query", "pattern", "program", "processId", "command", "cmd"]) {
    if (key in args) return truncate(`${key}=${args[key]}`, 80);
  }
  return "";
}

export class Renderer {
  constructor({ stream = process.stdout } = {}) {
    this.stream = stream;
    this.isTTY = Boolean(stream.isTTY);
    this.spinner = null;
    this.timer = null;
    this.frame = 0;
    // Tools resolve exactly once; track which callIds already produced a result
    // line so the several completion-shaped events never double-print.
    this.handled = new Set();
    this.toolStart = new Map();
    // A renderer lives for the whole interactive CLI session. Runtime turns
    // still emit lifecycle events when they resume the same web conversation,
    // but those milestones are only useful on the first turn.
    this.lifecycleShown = new Set();
  }

  // ---- spinner -----------------------------------------------------------

  #ensureTimer() {
    if (!this.isTTY) {
      return;
    }
    if (this.timer) {
      this.#render();
      return;
    }
    this.timer = setInterval(() => {
      this.frame += 1;
      this.#render();
    }, 120);
    this.timer.unref?.();
    this.#render();
  }

  #render() {
    if (!this.isTTY || !this.spinner) {
      return;
    }
    const frame = SPINNER[this.frame % SPINNER.length];
    const elapsed = ((Date.now() - this.spinner.start) / 1000).toFixed(1);
    let line = `${DIM}${frame} ${this.spinner.label} ${elapsed}s`;
    if (this.spinner.bytes) {
      line += ` · ${this.spinner.bytes} chars`;
    }
    line += RESET;
    this.stream.write(`\r\x1b[2K${line}`);
  }

  beginProcessing() {
    if (this.spinner?.kind === "processing") {
      return;
    }
    this.spinner = {
      kind: "processing",
      label: "processing request",
      start: Date.now(),
      bytes: 0,
    };
    this.#ensureTimer();
  }

  beginRunning(name) {
    this.spinner = {
      kind: "running",
      label: `running ${name}`,
      start: Date.now(),
      bytes: 0,
    };
    this.#ensureTimer();
  }

  addBytes(count) {
    if (this.spinner && count > 0) {
      this.spinner.bytes += count;
    }
  }

  stopSpinner() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.isTTY && this.spinner) {
      this.stream.write("\r\x1b[2K");
    }
    this.spinner = null;
  }

  // ---- output primitives -------------------------------------------------

  println(line = "") {
    if (this.isTTY && this.timer) {
      this.stream.write("\r\x1b[2K");
    }
    this.stream.write(`${line}\n`);
    if (this.isTTY && this.timer && this.spinner) {
      this.#render();
    }
  }

  #hdr() {
    return `${DIM}[${hms()}]${RESET}`;
  }

  status(message) {
    this.println(`${DIM}[${hms()}] ${message}${RESET}`);
  }

  note(message) {
    this.stopSpinner();
    this.println(`${this.#hdr()} ${YELLOW}${message}${RESET}`);
  }

  error(message) {
    this.stopSpinner();
    this.println(`${this.#hdr()} ${RED}${truncate(message, 300)}${RESET}`);
  }

  hint(message) {
    this.println(`${DIM}${message}${RESET}`);
  }

  banner(lines) {
    this.println("");
    for (const line of lines) {
      this.println(`${CYAN}${line}${RESET}`);
    }
    this.println("");
  }

  // ---- semantic renderers ------------------------------------------------

  #progress(message) {
    this.println(`${this.#hdr()} ${DIM}·${RESET} ${truncate(message, 300)}`);
  }

  #toolCall(name, args) {
    const summary = summarizeArgs(name, args);
    const tail = summary ? ` ${DIM}${summary}${RESET}` : "";
    this.println(`${this.#hdr()} ${CYAN}→ ${name}${RESET}${tail}`);
  }

  #elapsedFor(callId) {
    if (callId && this.toolStart.has(callId)) {
      const started = this.toolStart.get(callId);
      this.toolStart.delete(callId);
      return ((Date.now() - started) / 1000).toFixed(1);
    }
    return null;
  }

  #resultLine(name, ok, message, elapsed, { unknown = false } = {}) {
    const tail = elapsed != null ? ` ${DIM}(${elapsed}s)${RESET}` : "";
    if (ok) {
      this.println(`${this.#hdr()} ${GREEN}✓${RESET} ${name}${tail}`);
      return;
    }
    const mark = unknown ? YELLOW : RED;
    const detail = message ? `: ${truncate(message, 140)}` : "";
    this.println(`${this.#hdr()} ${mark}✗${RESET} ${name}${detail}${tail}`);
  }

  #result(result = {}, { unknown = false } = {}) {
    this.stopSpinner();
    const callId = result.callId;
    if (callId && this.handled.has(callId)) {
      return;
    }
    if (callId) {
      this.handled.add(callId);
    }
    const ok = Boolean(result.ok) && !unknown;
    this.#resultLine(result.name, ok, result.message, this.#elapsedFor(callId), {
      unknown,
    });
  }

  answer(message) {
    this.stopSpinner();
    this.println("");
    this.println(`${GREEN}${BOLD}⏺ assistant${RESET}`);
    for (const line of String(message ?? "").split(/\r?\n/)) {
      this.println(line);
    }
    this.println("");
  }

  finish() {
    this.stopSpinner();
    if (this.isTTY) {
      // Reset styling and make sure the cursor is visible on exit.
      this.stream.write(`${RESET}\x1b[?25h`);
    }
  }

  // ---- event dispatch ----------------------------------------------------

  handle(event) {
    const { type, payload = {} } = event ?? {};
    switch (type) {
      case "browser.started":
        if (this.lifecycleShown.has(type)) {
          break;
        }
        this.lifecycleShown.add(type);
        this.status("Chrome started.");
        break;
      case "browser.auth_required":
        this.stopSpinner();
        this.println(`${YELLOW}Log in to ChatGPT in the opened Chrome window…${RESET}`);
        break;
      case "browser.authenticated":
        this.println(`${GREEN}ChatGPT login detected.${RESET}`);
        break;
      case "conversation.mode_selected": {
        const { requested, status, selectedLabel } = payload;
        if (status === "select" || status === "already") {
          this.status(`Mode: ${selectedLabel ?? requested}.`);
        } else if (status === "fallback") {
          this.note(`Mode: ${requested} unavailable; using ${selectedLabel}.`);
        } else {
          this.note(`Mode: could not select ${requested}; continuing on current mode.`);
        }
        break;
      }
      case "conversation.started":
        if (this.lifecycleShown.has(type)) {
          break;
        }
        this.lifecycleShown.add(type);
        if (payload.mode) {
          this.status(`Conversation ready (${payload.mode}).`);
        } else {
          this.status("Conversation ready (current mode).");
        }
        break;
      case "model.message_sent":
        this.beginProcessing();
        break;
      case "model.streaming":
        this.beginProcessing();
        this.addBytes((payload.delta ?? "").length);
        break;
      case "model.message_complete":
        this.stopSpinner();
        break;
      case "model.progress":
        this.stopSpinner();
        if (payload.message) {
          this.#progress(payload.message);
        }
        break;
      case "protocol.invalid":
        this.note(`format retry${payload.count ? ` (${payload.count})` : ""}: ${truncate(payload.message, 100)}`);
        break;
      case "tool.proposed":
        this.stopSpinner();
        this.#toolCall(payload.name, payload.args);
        if (payload.id) {
          this.toolStart.set(payload.id, Date.now());
        }
        break;
      case "tool.started":
        this.beginRunning(payload.name);
        break;
      case "tool.output":
        this.addBytes((payload.chunk ?? "").length);
        break;
      case "tool.completed":
        this.#result(payload.result);
        break;
      case "tool.completion_unknown":
        this.#result(payload.result, { unknown: true });
        break;
      case "tool.invalid":
        this.stopSpinner();
        if (payload.id) {
          this.handled.add(payload.id);
        }
        this.#resultLine(payload.name, false, payload.message, null);
        break;
      case "tool.reused":
        this.stopSpinner();
        if (!payload.id || !this.handled.has(payload.id)) {
          if (payload.id) this.handled.add(payload.id);
          this.println(`${this.#hdr()} ${DIM}↺ reused prior result for ${payload.name}${RESET}`);
        }
        break;
      case "tool.reused_unknown":
        this.stopSpinner();
        if (!payload.id || !this.handled.has(payload.id)) {
          if (payload.id) this.handled.add(payload.id);
          this.println(`${this.#hdr()} ${YELLOW}↺ reused (completion unknown) for ${payload.name}${RESET}`);
        }
        break;
      case "tool.conflict":
        this.stopSpinner();
        if (!payload.id || !this.handled.has(payload.id)) {
          if (payload.id) this.handled.add(payload.id);
          this.note(`conflicting reuse for ${payload.name}`);
        }
        break;
      case "run.completed":
        this.answer(payload.message);
        break;
      case "run.interrupted":
        this.stopSpinner();
        this.println(`${YELLOW}Run interrupted: ${truncate(payload.message, 160)}${RESET}`);
        break;
      case "tool.result_sent":
        // A tool result was just sent to the model; we are waiting on the next
        // reply, so bring the processing spinner back.
        this.beginProcessing();
        break;
      default:
        break;
    }
  }
}

export function createRenderer(options) {
  return new Renderer(options);
}
