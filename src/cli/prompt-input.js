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
const SHIFT_ENTER_KITTY = "\u001b[13;2u";
const SHIFT_ENTER_MODIFY_OTHER = "\u001b[27;2;13~";
const SHIFT_ENTER_ESC_CR = "\u001b\r";
const SHIFT_ENTER_SEQUENCES = Object.freeze([
  SHIFT_ENTER_KITTY,
  SHIFT_ENTER_MODIFY_OTHER,
  SHIFT_ENTER_ESC_CR,
]);
const ENABLE_KITTY_KEYBOARD = "\u001b[>1u";
const DISABLE_KITTY_KEYBOARD = "\u001b[<1u";
const ENABLE_MODIFY_OTHER_KEYS = "\u001b[>4;2m";
const DISABLE_MODIFY_OTHER_KEYS = "\u001b[>4;0m";

const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";
const KEY_RIGHT = "\u001b[C";
const KEY_LEFT = "\u001b[D";
const KEY_HOME = "\u001b[H";
const KEY_END = "\u001b[F";
const KEY_HOME_TILDE = "\u001b[1~";
const KEY_END_TILDE = "\u001b[4~";
const KEY_HOME_APP = "\u001bOH";
const KEY_END_APP = "\u001bOF";
const KEY_DELETE = "\u001b[3~";

// Every escape sequence the editor understands, used both for dispatch and to
// hold a split-across-chunks prefix back instead of inserting it as text.
const KNOWN_ESCAPE_SEQUENCES = Object.freeze([
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
  KEY_UP,
  KEY_DOWN,
  KEY_RIGHT,
  KEY_LEFT,
  KEY_HOME,
  KEY_END,
  KEY_HOME_TILDE,
  KEY_END_TILDE,
  KEY_HOME_APP,
  KEY_END_APP,
  KEY_DELETE,
  SHIFT_ENTER_KITTY,
  SHIFT_ENTER_MODIFY_OTHER,
  SHIFT_ENTER_ESC_CR,
]);

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

// Rough terminal cell width for one code point. Good enough for wrap and
// cursor math on typical chat input: CJK/fullwidth/emoji count 2, combining
// marks count 0, everything else 1.
function charWidth(codePoint) {
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115F
      || (codePoint >= 0x2E80 && codePoint <= 0xA4CF)
      || (codePoint >= 0xAC00 && codePoint <= 0xD7A3)
      || (codePoint >= 0xF900 && codePoint <= 0xFAFF)
      || (codePoint >= 0xFE10 && codePoint <= 0xFE19)
      || (codePoint >= 0xFE30 && codePoint <= 0xFE6F)
      || (codePoint >= 0xFF00 && codePoint <= 0xFF60)
      || (codePoint >= 0xFFE0 && codePoint <= 0xFFE6)
      || (codePoint >= 0x1F300 && codePoint <= 0x1F64F)
      || (codePoint >= 0x1F900 && codePoint <= 0x1F9FF)
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

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text ?? "")) {
    width += charWidth(ch.codePointAt(0));
  }
  return width;
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
    const columns = () => Math.max(10, Number(inputStream.columns) || 80);

    let buffer = []; // flat code-point buffer; "\n" chars are real line breaks
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
    const finishLine = () => {
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
      buffer = [...String(text)];
      cursor = buffer.length;
      render();
    };

    const insertText = (text) => {
      const chars = [...String(text)];
      buffer.splice(cursor, 0, ...chars);
      cursor += chars.length;
      historyIndex = this.history.length;
      render();
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
        if (ch === "") {
          cancel();
          return;
        }
        if (ch === "") {
          if (buffer.length === 0) {
            done(null);
          } else if (cursor < buffer.length) {
            buffer.splice(cursor, 1);
            historyIndex = this.history.length;
            render();
          }
          continue;
        }
        if (ch === "" || ch === "") {
          if (cursor > 0) {
            buffer.splice(cursor - 1, 1);
            cursor -= 1;
            historyIndex = this.history.length;
            render();
          }
          continue;
        }
        if (ch === "") {
          cursor = 0;
          render();
          continue;
        }
        if (ch === "") {
          cursor = buffer.length;
          render();
          continue;
        }
        if (ch === "") {
          buffer = buffer.slice(0, cursor);
          historyIndex = this.history.length;
          render();
          continue;
        }
        if (ch === "") {
          buffer = [];
          cursor = 0;
          historyIndex = this.history.length;
          render();
          continue;
        }
        insertText(ch);
      }
    };

    const handleSequence = (sequence) => {
      switch (sequence) {
        case BRACKETED_PASTE_START:
          inPaste = true;
          return;
        case BRACKETED_PASTE_END:
          inPaste = false;
          return;
        case KEY_UP:
          historyPrev();
          return;
        case KEY_DOWN:
          historyNext();
          return;
        case KEY_RIGHT:
          cursor = Math.min(cursor + 1, buffer.length);
          render();
          return;
        case KEY_LEFT:
          cursor = Math.max(cursor - 1, 0);
          render();
          return;
        case KEY_HOME:
        case KEY_HOME_TILDE:
        case KEY_HOME_APP:
          cursor = 0;
          render();
          return;
        case KEY_END:
        case KEY_END_TILDE:
        case KEY_END_APP:
          cursor = buffer.length;
          render();
          return;
        case KEY_DELETE:
          if (cursor < buffer.length) {
            buffer.splice(cursor, 1);
            historyIndex = this.history.length;
            render();
          }
          return;
        default:
          break;
      }
      if (SHIFT_ENTER_SEQUENCES.includes(sequence)) {
        insertText("\n");
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

        // pending starts with ESC.
        const sequence = KNOWN_ESCAPE_SEQUENCES.find((candidate) => (
          pending.startsWith(candidate)
        ));
        if (sequence) {
          handleSequence(sequence);
          pending = pending.slice(sequence.length);
          continue;
        }
        if (
          pending.length === 1
          || KNOWN_ESCAPE_SEQUENCES.some((candidate) => (
            candidate.startsWith(pending)
          ))
        ) {
          // The rest of the sequence may arrive in the next chunk.
          return;
        }
        // Unknown escape: drop the ESC byte and re-scan what follows.
        pending = pending.slice(1);
      }
    };

    // Draws the prompt + buffer with REAL line breaks, tracks wrapping, and
    // places the cursor at the flat cursor index.
    const render = () => {
      const width = columns();
      const promptWidth = displayWidth(prompt);
      const text = buffer.join("");

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
      for (const ch of text) {
        if (ch === "\n") {
          flush();
          charIndex += 1;
          continue;
        }
        const w = charWidth(ch.codePointAt(0));
        const base = rendered.length === 0 ? promptWidth : 0;
        if (base + currentWidth + w > width && currentWidth > 0) {
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

      if (linesDrawn > 1) {
        outputStream.write(`\x1b[${linesDrawn - 1}A`);
      }
      outputStream.write("\r");
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
      if (rendered.length < linesDrawn) {
        for (let index = rendered.length; index < linesDrawn; index += 1) {
          outputStream.write("\x1b[2K");
          if (index < linesDrawn - 1) {
            outputStream.write("\r\n");
          }
        }
      }
      linesDrawn = rendered.length;

      // Position the cursor at the flat cursor index.
      let row = rendered.length - 1;
      let col = 0;
      for (let r = 0; r < rendered.length; r += 1) {
        const range = ranges[r];
        if (cursor < range.end || r === rendered.length - 1) {
          row = r;
          const base = r === 0 ? promptWidth : 0;
          const prefixLength = Math.max(0, cursor - range.start);
          col = base + displayWidth(
            [...rendered[r]].slice(0, prefixLength).join(""),
          );
          break;
        }
      }
      cursorRow = row;
      // Drawing ends at the last rendered line; move UP to the cursor's row.
      const moveUp = rendered.length - 1 - row;
      if (moveUp > 0) {
        outputStream.write(`\x1b[${moveUp}A`);
      }
      outputStream.write("\r");
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
