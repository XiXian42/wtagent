import { confirm, input, select } from "@inquirer/prompts";
import { StringDecoder } from "node:string_decoder";

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";
// Shift+Enter encodings we can actually distinguish from a plain Enter:
//   CSI-u (kitty / iTerm CSI-u)     ESC [ 13 ; 2 u
//   xterm modifyOtherKeys            ESC [ 27 ; 2 ; 13 ~
//   ESC + CR                         some iTerm / VS Code / tmux setups
// Terminals that still send a bare CR for Shift+Enter cannot be disambiguated;
// Ctrl+J (bare LF in raw mode) is the reliable fallback and is also mapped.
const SHIFT_ENTER_ESC_CR = "\u001b\r";
const ENABLE_KITTY_KEYBOARD = "\u001b[>1u";
const DISABLE_KITTY_KEYBOARD = "\u001b[<1u";
const ENABLE_MODIFY_OTHER_KEYS = "\u001b[>4;2m";
const DISABLE_MODIFY_OTHER_KEYS = "\u001b[>4;0m";
// DECAWM: if a redraw fills the last column, the terminal otherwise wraps onto a
// phantom next row (XENL). CJK is width 2 so it hits that edge constantly, and
// the next backspace then leaves the "deleted" glyph sitting on that extra row.
const DISABLE_AUTOWRAP = "\u001b[?7l";
const ENABLE_AUTOWRAP = "\u001b[?7h";

const SS3_ACTIONS = Object.freeze({
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
});

const CLEAN_EXIT_ERRORS = new Set([
  "AbortPromptError",
  "ExitPromptError",
]);
const EXIT_COMMANDS = new Set([
  "exit",
  "quit",
  ":q",
  "/exit",
  "/quit",
]);

// Rough terminal cell width for one code point. CJK/fullwidth/emoji count 2,
// combining marks count 0, everything else 1 — including East-Asian Ambiguous
// (quotes, dashes, ›, box drawing), which wcwidth and every default terminal
// config render as 1 cell.
//
// The › in the prompt makes this a hard rule, not a taste call: the 7-cell
// prompt is ODD and every CJK glyph is 2 cells, so the cursor column after any
// amount of CJK is always odd = the LEADING cell of a glyph. macOS Terminal.app
// does not draw the cursor on a glyph's trailing cell, so counting › as 2
// (prompt 8, even) makes the cursor land on trailing cells and visibly blink
// in and out of existence while typing Chinese.
export function charWidth(codePoint) {
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115F
      || (codePoint >= 0x2E80 && codePoint <= 0xA4CF)
      || (codePoint >= 0xA960 && codePoint <= 0xA97F)
      || (codePoint >= 0xAC00 && codePoint <= 0xD7FB)
      || (codePoint >= 0xF900 && codePoint <= 0xFAFF)
      || (codePoint >= 0xFE10 && codePoint <= 0xFE19)
      || (codePoint >= 0xFE30 && codePoint <= 0xFE6F)
      || (codePoint >= 0xFF00 && codePoint <= 0xFF60)
      || (codePoint >= 0xFFE0 && codePoint <= 0xFFE6)
      || (codePoint >= 0x1F300 && codePoint <= 0x1FAFF)
      || (codePoint >= 0x20000 && codePoint <= 0x3FFFD)
    )
  ) {
    return 2;
  }
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036F)
    || (codePoint >= 0x1AB0 && codePoint <= 0x1AFF)
    || (codePoint >= 0x1DC0 && codePoint <= 0x1DFF)
    || (codePoint >= 0x20D0 && codePoint <= 0x20FF)
    || (codePoint >= 0xFE00 && codePoint <= 0xFE0F)
    || codePoint === 0x200D
  ) {
    return 0;
  }
  return 1;
}

export function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? "")) {
    width += charWidth(ch.codePointAt(0));
  }
  return width;
}

function splitGraphemes(text) {
  const value = String(text ?? "");
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" })
      .segment(value)]
      .map((part) => part.segment);
  }
  return [...value];
}

function graphemeWidth(grapheme) {
  let width = 0;
  for (const ch of String(grapheme ?? "")) {
    width += charWidth(ch.codePointAt(0));
  }
  return width;
}

// Parse one escape at the start of `text`. Incomplete sequences (split across
// TTY chunks) are held back; complete unknown CSI is consumed, never inserted.
function matchEscape(text) {
  if (!text.startsWith("\u001b")) {
    return null;
  }
  if (text.length === 1) {
    return { incomplete: true };
  }
  if (text[1] === "\r") {
    return { sequence: SHIFT_ENTER_ESC_CR, kind: "shift-enter" };
  }
  if (text[1] === "O") {
    if (text.length < 3) {
      return { incomplete: true };
    }
    return { sequence: text.slice(0, 3), kind: "ss3", final: text[2] };
  }
  if (text[1] === "[") {
    let index = 2;
    while (
      index < text.length
      && text.charCodeAt(index) >= 0x30
      && text.charCodeAt(index) <= 0x3F
    ) {
      index += 1;
    }
    while (
      index < text.length
      && text.charCodeAt(index) >= 0x20
      && text.charCodeAt(index) <= 0x2F
    ) {
      index += 1;
    }
    if (index >= text.length) {
      return { incomplete: true };
    }
    const finalCode = text.charCodeAt(index);
    if (finalCode < 0x40 || finalCode > 0x7E) {
      return { sequence: "\u001b", kind: "unknown" };
    }
    return {
      sequence: text.slice(0, index + 1),
      kind: "csi",
      final: text[index],
      params: text.slice(2, index),
    };
  }
  return { sequence: text.slice(0, 2), kind: "unknown" };
}

function parseCsiParams(params) {
  const body = String(params ?? "").replace(/^[?<>]/, "");
  if (!body) {
    return [];
  }
  return body.split(";").map((part) => {
    const base = part.split(":")[0];
    const value = Number(base);
    return Number.isFinite(value) && base.length > 0 ? value : 0;
  });
}

function classifyUnicodeKey(key, mods) {
  const bits = Math.max(0, (mods || 1) - 1);
  const shift = (bits & 1) !== 0;
  const ctrl = (bits & 4) !== 0;
  if (key === 13) {
    return shift ? { type: "newline" } : { type: "submit" };
  }
  if (key === 10) {
    return { type: "newline" };
  }
  if (key === 127 || key === 8) {
    return { type: "backspace" };
  }
  if (key === 27 || key === 9) {
    return { type: "ignore" };
  }
  if (ctrl) {
    if (key === 99 || key === 67) {
      return { type: "cancel" };
    }
    if (key === 100 || key === 68) {
      return { type: "eof-or-delete" };
    }
    if (key === 97 || key === 65) {
      return { type: "home" };
    }
    if (key === 101 || key === 69) {
      return { type: "end" };
    }
    if (key === 107 || key === 75) {
      return { type: "kill-line" };
    }
    if (key === 117 || key === 85) {
      return { type: "kill-all" };
    }
  }
  return { type: "ignore" };
}

function classifyCsi(final, params) {
  const nums = parseCsiParams(params);
  if (final === "u") {
    return classifyUnicodeKey(nums[0] || 0, nums[1] || 1);
  }
  if (final === "~") {
    const first = nums[0] || 0;
    if (first === 200) {
      return { type: "paste-start" };
    }
    if (first === 201) {
      return { type: "paste-end" };
    }
    if (first === 3) {
      return { type: "delete" };
    }
    if (first === 1) {
      return { type: "home" };
    }
    if (first === 4) {
      return { type: "end" };
    }
    if (first === 27) {
      return classifyUnicodeKey(nums[2] || 0, nums[1] || 1);
    }
    return { type: "ignore" };
  }
  if (final === "A") {
    return { type: "up" };
  }
  if (final === "B") {
    return { type: "down" };
  }
  if (final === "C") {
    return { type: "right" };
  }
  if (final === "D") {
    return { type: "left" };
  }
  if (final === "H") {
    return { type: "home" };
  }
  if (final === "F") {
    return { type: "end" };
  }
  return { type: "ignore" };
}

// Longest tail of `text` that is a strict prefix of `sequence` — the part that
// must be held back because the sequence may continue in the next chunk.
function longestPrefixAtEnd(text, sequence) {
  const limit = Math.min(text.length, sequence.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (sequence.startsWith(text.slice(-length))) {
      return length;
    }
  }
  return 0;
}

export function classifyChatInput(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return { kind: "empty", text: "" };
  }
  if (EXIT_COMMANDS.has(text.toLowerCase())) {
    return { kind: "exit", text };
  }
  return { kind: "message", text };
}

export async function readChatMessage(read) {
  for (;;) {
    const answer = await read();
    if (answer == null) {
      return null;
    }
    const classified = classifyChatInput(answer);
    if (classified.kind === "empty") {
      continue;
    }
    if (classified.kind === "exit") {
      return null;
    }
    return classified.text;
  }
}

// Interactive chat input: a small raw-mode multi-line editor. Newlines are
// REAL newlines — pasted line breaks and Shift+Enter/Ctrl+J are visible while
// editing (readline's single-line buffer forced an invisible U+2028 encoding
// instead). Enter submits, ↑/↓ walk history, ←/→/Home/End move the cursor,
// Ctrl+C / Ctrl+D cancel.
export class ShellChatInput {
  constructor({
    inputStream = process.stdin,
    outputStream = process.stdout,
    historySize = 100,
  } = {}) {
    this.inputStream = inputStream;
    this.outputStream = outputStream;
    this.historySize = historySize;
    this.history = [];
  }

  remember(value) {
    const text = String(value ?? "").trim();
    if (!text) {
      return;
    }
    this.history = [
      text,
      ...this.history.filter((entry) => entry !== text),
    ].slice(0, this.historySize);
  }

  async read(prompt = " you › ") {
    if (this.inputStream.readableEnded) {
      return null;
    }
    return await new Promise((resolve) => {
      this.#edit(prompt, resolve);
    });
  }

  close() {
    // Each read() owns its raw-mode session and cleans it up on completion.
    // This method keeps ownership explicit for callers and future extensions.
  }

  #edit(prompt, resolve) {
    const inputStream = this.inputStream;
    const outputStream = this.outputStream;
    const previousRaw = inputStream.isRaw;
    const decoder = new StringDecoder("utf8");
    // Terminal width lives on the TTY *output* stream; process.stdin.columns is
    // undefined, so reading it always fell back to 80 — wrapping CJK input after
    // ~40 chars and, worse, making the editor's multi-line row model disagree
    // with the terminal's real wrapping (arrow-key redraws then duplicated the
    // input up the screen). Prefer the output stream's live column count.
    const columns = () => Math.max(
      10,
      Number(outputStream.columns)
        || Number(inputStream.columns)
        || 80,
    );

    let buffer = []; // grapheme clusters; "\n" entries are real line breaks
    let cursor = 0;
    let historyIndex = this.history.length;
    let draft = "";
    let pending = ""; // undecoded partial escape sequence / paste terminator
    let inPaste = false;
    let settled = false;
    let linesDrawn = 1;
    let cursorRow = 0;

    const cleanup = () => {
      inputStream.removeListener("data", onData);
      inputStream.removeListener("end", onEnd);
      inputStream.removeListener("close", onEnd);
      inputStream.setRawMode?.(previousRaw);
      outputStream.write(ENABLE_AUTOWRAP);
      outputStream.write(DISABLE_MODIFY_OTHER_KEYS);
      outputStream.write(DISABLE_BRACKETED_PASTE);
      outputStream.write(DISABLE_KITTY_KEYBOARD);
      // A lingering 'data' listener (e.g. readline's keypress machinery left by
      // the adapter's ESC-cancel attach) would keep the TTY read active and
      // pin the event loop open; pausing lets the process exit between turns.
      inputStream.pause();
    };

    const done = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };

    // Moves to the end of the drawn input and starts a fresh line.
    // CR first: CUU/CUD from the trailing cell of a CJK glyph splits it in
    // half on macOS Terminal.app. Column 0 is always a safe cell boundary.
    const finishLine = () => {
      outputStream.write("\r");
      if (cursorRow < linesDrawn - 1) {
        outputStream.write(`\x1b[${linesDrawn - 1 - cursorRow}B`);
      }
      outputStream.write("\r\n");
    };

    const submit = () => {
      const text = buffer.join("");
      if (text.trim()) {
        this.remember(text);
      }
      finishLine();
      done(text);
    };

    const cancel = () => {
      finishLine();
      done(null);
    };

    const setBufferText = (text) => {
      buffer = splitGraphemes(text);
      cursor = buffer.length;
      render();
    };

    const insertText = (text) => {
      const chars = splitGraphemes(text).filter((ch) => ch !== "\u001b");
      if (chars.length === 0) {
        return;
      }
      buffer.splice(cursor, 0, ...chars);
      cursor += chars.length;
      historyIndex = this.history.length;
      render();
    };

    const applyBackspace = () => {
      if (cursor > 0) {
        buffer.splice(cursor - 1, 1);
        cursor -= 1;
        historyIndex = this.history.length;
        render();
      }
    };

    const applyDelete = () => {
      if (cursor < buffer.length) {
        buffer.splice(cursor, 1);
        historyIndex = this.history.length;
        render();
      }
    };

    // historyIndex is the DISPLAYED entry's index, or history.length while the
    // user edits the fresh draft. ↑ walks into the list newest-first; ↓ walks
    // back out and restores the draft.
    const historyPrev = () => {
      if (this.history.length === 0) {
        return;
      }
      if (historyIndex === this.history.length) {
        draft = buffer.join("");
        historyIndex = 0;
      } else if (historyIndex < this.history.length - 1) {
        historyIndex += 1;
      }
      setBufferText(this.history[historyIndex]);
    };

    const historyNext = () => {
      if (historyIndex === this.history.length) {
        return;
      }
      if (historyIndex === 0) {
        historyIndex = this.history.length;
        setBufferText(draft);
      } else {
        historyIndex -= 1;
        setBufferText(this.history[historyIndex]);
      }
    };

    const handleAction = (action) => {
      switch (action?.type) {
        case "paste-start":
          inPaste = true;
          return;
        case "paste-end":
          inPaste = false;
          return;
        case "up":
          historyPrev();
          return;
        case "down":
          historyNext();
          return;
        case "right":
          cursor = Math.min(cursor + 1, buffer.length);
          render();
          return;
        case "left":
          cursor = Math.max(cursor - 1, 0);
          render();
          return;
        case "home":
          cursor = 0;
          render();
          return;
        case "end":
          cursor = buffer.length;
          render();
          return;
        case "backspace":
          applyBackspace();
          return;
        case "delete":
          applyDelete();
          return;
        case "submit":
          submit();
          return;
        case "newline":
          insertText("\n");
          return;
        case "cancel":
          cancel();
          return;
        case "eof-or-delete":
          if (buffer.length === 0) {
            done(null);
          } else {
            applyDelete();
          }
          return;
        case "kill-line":
          buffer = buffer.slice(0, cursor);
          historyIndex = this.history.length;
          render();
          return;
        case "kill-all":
          buffer = [];
          cursor = 0;
          historyIndex = this.history.length;
          render();
          return;
        default:
          return;
      }
    };

    const handlePlainText = (text) => {
      for (const ch of String(text)) {
        if (ch === "\r") {
          submit();
          return;
        }
        if (ch === "\n") {
          insertText("\n");
          continue;
        }
        if (ch === "\u0003") {
          cancel();
          return;
        }
        if (ch === "\u0004") {
          if (buffer.length === 0) {
            done(null);
          } else {
            applyDelete();
          }
          continue;
        }
        if (ch === "\u007f" || ch === "\u0008") {
          applyBackspace();
          continue;
        }
        if (ch === "\u0001") {
          cursor = 0;
          render();
          continue;
        }
        if (ch === "\u0005") {
          cursor = buffer.length;
          render();
          continue;
        }
        if (ch === "\u000b") {
          buffer = buffer.slice(0, cursor);
          historyIndex = this.history.length;
          render();
          continue;
        }
        if (ch === "\u0015") {
          buffer = [];
          cursor = 0;
          historyIndex = this.history.length;
          render();
          continue;
        }
        insertText(ch);
      }
    };

    const consume = (text) => {
      pending += text;
      for (;;) {
        if (inPaste) {
          // Inside a bracketed paste everything is data; only the end marker
          // is special (and it can arrive split across chunks).
          const endIndex = pending.indexOf(BRACKETED_PASTE_END);
          if (endIndex >= 0) {
            insertText(
              pending.slice(0, endIndex).replace(/\r\n|\r/g, "\n"),
            );
            pending = pending.slice(endIndex + BRACKETED_PASTE_END.length);
            inPaste = false;
            continue;
          }
          const retained = longestPrefixAtEnd(pending, BRACKETED_PASTE_END);
          const ready = pending.slice(0, pending.length - retained);
          if (ready) {
            insertText(ready.replace(/\r\n|\r/g, "\n"));
          }
          pending = pending.slice(pending.length - retained);
          return;
        }

        const escapeIndex = pending.indexOf("\u001b");
        if (escapeIndex < 0) {
          handlePlainText(pending);
          pending = "";
          return;
        }
        if (escapeIndex > 0) {
          handlePlainText(pending.slice(0, escapeIndex));
          pending = pending.slice(escapeIndex);
          continue;
        }

        const matched = matchEscape(pending);
        if (!matched) {
          handlePlainText(pending);
          pending = "";
          return;
        }
        if (matched.incomplete) {
          return;
        }
        if (matched.kind === "shift-enter") {
          handleAction({ type: "newline" });
        } else if (matched.kind === "ss3") {
          const type = SS3_ACTIONS[matched.final];
          if (type) {
            handleAction({ type });
          }
        } else if (matched.kind === "csi") {
          handleAction(classifyCsi(matched.final, matched.params));
        }
        pending = pending.slice(matched.sequence.length);
      }
    };

    // Draws the prompt + buffer with REAL line breaks, tracks wrapping, and
    // places the cursor at the flat cursor index.
    const render = () => {
      const width = columns();
      const promptWidth = displayWidth(prompt);

      const rendered = [];
      const ranges = []; // { start, end } flat char indices per rendered line
      let current = "";
      let currentWidth = 0;
      let rangeStart = 0;
      let charIndex = 0;
      const flush = () => {
        rendered.push(current);
        ranges.push({ start: rangeStart, end: charIndex });
        current = "";
        currentWidth = 0;
        rangeStart = charIndex;
      };
      for (let index = 0; index < buffer.length; index += 1) {
        const ch = buffer[index];
        if (ch === "\n") {
          flush();
          charIndex += 1;
          // The "\n" itself belongs to no rendered line. flush() left
          // rangeStart on the "\n"'s index, so the next line's range would
          // include it — and the cursor column (displayWidth of the row
          // prefix) came out 1 too far right on every row after a newline,
          // parking the cursor on a CJK glyph's trailing cell where macOS
          // Terminal.app hides it (the "cursor blinks out" bug).
          rangeStart = charIndex;
          continue;
        }
        const w = graphemeWidth(ch);
        const base = rendered.length === 0 ? promptWidth : 0;
        // `>= width` (not `>`): filling the last column trips terminal autowrap
        // even with DECAWM off on some emulators, and CJK (width 2) lands on
        // that boundary far more often than ASCII. Keep one spare cell so the
        // editor's row model and the physical cursor stay aligned.
        if (base + currentWidth + w >= width && currentWidth > 0) {
          flush();
        }
        current += ch;
        currentWidth += w;
        charIndex += 1;
      }
      flush();
      if (rendered.length === 0) {
        rendered.push("");
        ranges.push({ start: 0, end: 0 });
      }

      // The previous render left the physical cursor on row `cursorRow`, which
      // is NOT always the last drawn row: arrowing left/up into an earlier
      // wrapped row leaves it higher. Move up by that actual row to reach the
      // top — using `linesDrawn - 1` here overshoots whenever the cursor sits
      // above the bottom row, drifting the whole block up the screen on every
      // keystroke (duplicating wrapped lines). Mirror of finishLine()'s move.
      // CR first: CUU from the trailing cell of a CJK glyph splits it in half
      // on macOS Terminal.app. Column 0 is always a safe cell boundary.
      outputStream.write("\r");
      if (cursorRow > 0) {
        outputStream.write(`\x1b[${cursorRow}A`);
      }
      for (let index = 0; index < rendered.length; index += 1) {
        outputStream.write("\x1b[2K");
        if (index === 0) {
          outputStream.write(prompt);
        }
        outputStream.write(rendered[index]);
        if (index < rendered.length - 1) {
          outputStream.write("\r\n");
        }
      }
      // Erase leftover rows from a previous taller wrap (CJK backspace/unwrap).
      // ED 0 from the end of the last content line. The old shrink path CSI-2K'd
      // the current line instead — wiping the row we just drew and never moving
      // onto the stale row below, so the "deleted" glyph stayed visible.
      outputStream.write("\x1b[J");
      linesDrawn = rendered.length;

      // Position the cursor at the flat cursor index.
      let row = rendered.length - 1;
      let col = 0;
      for (let r = 0; r < rendered.length; r += 1) {
        const range = ranges[r];
        if (cursor < range.end || r === rendered.length - 1) {
          row = r;
          const base = r === 0 ? promptWidth : 0;
          col = base + displayWidth(
            buffer.slice(range.start, cursor).join(""),
          );
          break;
        }
      }
      cursorRow = row;
      // Drawing ends at the last rendered line; CR first, then move UP. After
      // the CR the cursor is at column 0, so CUU keeps column 0 — no second CR
      // is needed before the CUF.
      const moveUp = rendered.length - 1 - row;
      outputStream.write("\r");
      if (moveUp > 0) {
        outputStream.write(`\x1b[${moveUp}A`);
      }
      if (col > 0) {
        outputStream.write(`\x1b[${col}C`);
      }
    };

    const onEnd = () => done(null);
    const onData = (chunk) => {
      try {
        consume(decoder.write(chunk));
      } catch (error) {
        finishLine();
        done(null);
        throw error;
      }
    };

    inputStream.setRawMode?.(true);
    outputStream.write(DISABLE_AUTOWRAP);
    outputStream.write(ENABLE_BRACKETED_PASTE);
    // Ask the terminal to disambiguate modified Enter. Kitty CSI-u covers
    // kitty/iTerm; xterm modifyOtherKeys covers many others, including some
    // tmux + iTerm combinations. Terminals that ignore both still send a bare
    // CR for Shift+Enter, which cannot be distinguished from Enter — Ctrl+J
    // always works as the newline fallback.
    outputStream.write(ENABLE_KITTY_KEYBOARD);
    outputStream.write(ENABLE_MODIFY_OTHER_KEYS);
    render();
    inputStream.on("data", onData);
    inputStream.on("end", onEnd);
    inputStream.on("close", onEnd);
    // A previous cleanup paused the stream (so a lingering 'data' listener
    // cannot pin the event loop); after an explicit pause() attaching a
    // listener alone does not resume it, so resume explicitly.
    inputStream.resume?.();
  }
}

async function promptWithCleanExit(config, {
  prompt,
  inputStream = process.stdin,
  outputStream = process.stdout,
}) {
  if (inputStream.readableEnded) {
    return null;
  }

  const controller = new AbortController();
  let reachedEof = false;
  const onEof = () => {
    reachedEof = true;
    controller.abort();
  };

  inputStream.once("end", onEof);
  inputStream.once("close", onEof);

  try {
    return await prompt(config, {
      input: inputStream,
      output: outputStream,
      signal: controller.signal,
    });
  } catch (error) {
    if (
      reachedEof
      || CLEAN_EXIT_ERRORS.has(error?.name)
    ) {
      return null;
    }
    throw error;
  } finally {
    inputStream.removeListener("end", onEof);
    inputStream.removeListener("close", onEof);
  }
}

export async function promptForText(config, options = {}) {
  return await promptWithCleanExit(config, {
    ...options,
    prompt: options.prompt ?? input,
  });
}

export async function promptForSelect(config, options = {}) {
  return await promptWithCleanExit(config, {
    ...options,
    prompt: options.prompt ?? select,
  });
}

export async function promptForConfirm(config, options = {}) {
  return await promptWithCleanExit(config, {
    ...options,
    prompt: options.prompt ?? confirm,
  });
}
