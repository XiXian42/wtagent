import { input, select } from "@inquirer/prompts";
import { createInterface } from "node:readline/promises";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const ENABLE_BRACKETED_PASTE = "\u001b[?2004h";
const DISABLE_BRACKETED_PASTE = "\u001b[?2004l";
// readline treats CR/LF as submit. U+2028 is a non-submitting, semantic line
// separator that can live in readline's editable buffer and history; decode it
// back to LF before the value leaves this module.
const PASTED_LINE_SEPARATOR = "\u2028";
// Shift+Enter from terminals with kitty keyboard protocol support arrives as
// the CSI-u sequence for "Enter with shift". Map it to the same non-submitting
// line separator used for pasted newlines so it inserts a newline instead of
// submitting. Terminals without the protocol keep sending plain CR for
// Shift+Enter, which readline treats as submit — an unavoidable terminal limit.
const SHIFT_ENTER_SEQUENCE = "\u001b[13;2u";
const ENABLE_KITTY_KEYBOARD = "\u001b[>1u";
const DISABLE_KITTY_KEYBOARD = "\u001b[<1u";

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

function longestMarkerPrefixAtEnd(text, marker) {
  const limit = Math.min(text.length, marker.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function encodePastedLines(text) {
  return text.replace(/\r\n|\r|\n/g, PASTED_LINE_SEPARATOR);
}

function decodePastedLines(text) {
  return String(text ?? "").replaceAll(PASTED_LINE_SEPARATOR, "\n");
}

function looksLikeUnbracketedMultilinePaste(text) {
  const normalized = text.replace(/\r\n|\r/g, "\n");
  const firstNewline = normalized.indexOf("\n");
  if (firstNewline < 0) {
    return false;
  }
  // A newline followed by more text, or two or more newlines in one raw data
  // event, cannot be a single Enter key. Treat it as an unmarked paste. A
  // normal test/pipe write such as "message\n" remains a submit.
  return firstNewline < normalized.length - 1
    || normalized.indexOf("\n", firstNewline + 1) >= 0;
}

class PasteAwareInput extends Transform {
  constructor(source) {
    super();
    this.decoder = new StringDecoder("utf8");
    this.pending = "";
    this.inBracketedPaste = false;
    this.isTTY = source.isTTY;
    this.columns = source.columns;
    this.setRawMode = typeof source.setRawMode === "function"
      ? (enabled) => source.setRawMode(enabled)
      : undefined;
  }

  _transform(chunk, _encoding, callback) {
    try {
      this.#consume(this.decoder.write(chunk), false);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  _flush(callback) {
    try {
      this.#consume(this.decoder.end(), true);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  #consume(text, flush) {
    this.pending += text;
    let output = "";

    for (;;) {
      const marker = this.inBracketedPaste
        ? BRACKETED_PASTE_END
        : BRACKETED_PASTE_START;
      const markerIndex = this.pending.indexOf(marker);
      if (markerIndex >= 0) {
        const before = this.pending.slice(0, markerIndex);
        output += this.inBracketedPaste
          ? encodePastedLines(before)
          : this.#outsidePaste(before);
        this.pending = this.pending.slice(markerIndex + marker.length);
        this.inBracketedPaste = !this.inBracketedPaste;
        continue;
      }

      // A Shift+Enter sequence can also arrive split across chunks; keep any
      // partial prefix pending so it is not pushed through as literal text.
      const markerRetained = flush
        ? 0
        : longestMarkerPrefixAtEnd(this.pending, marker);
      const shiftEnterRetained = flush
        ? 0
        : longestMarkerPrefixAtEnd(this.pending, SHIFT_ENTER_SEQUENCE);
      const retained = Math.max(markerRetained, shiftEnterRetained);
      const ready = this.pending.slice(0, this.pending.length - retained);
      output += this.inBracketedPaste
        ? encodePastedLines(ready)
        : this.#outsidePaste(ready);
      this.pending = this.pending.slice(this.pending.length - retained);
      break;
    }

    if (output) {
      this.push(output);
    }
  }

  #outsidePaste(text) {
    // Shift+Enter (CSI-u "Enter with shift") is a newline, not a submit. Map
    // it to the same non-submitting line separator readline keeps in its
    // editable buffer, then decode it back to LF with the rest on output.
    const withNewlines = text.replaceAll(
      SHIFT_ENTER_SEQUENCE,
      PASTED_LINE_SEPARATOR,
    );
    return looksLikeUnbracketedMultilinePaste(withNewlines)
      ? encodePastedLines(withNewlines)
      : withNewlines;
  }
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

    const pasteInput = new PasteAwareInput(this.inputStream);
    this.inputStream.pipe(pasteInput);
    this.outputStream.write(ENABLE_BRACKETED_PASTE);
    // Ask the terminal to disambiguate modified Enter via kitty keyboard
    // protocol (level 1). Terminals that ignore it keep sending plain CR for
    // Shift+Enter, which is submitted like Enter.
    this.outputStream.write(ENABLE_KITTY_KEYBOARD);

    const readline = createInterface({
      input: pasteInput,
      output: this.outputStream,
      terminal: true,
      historySize: this.historySize,
      removeHistoryDuplicates: true,
    });
    readline.history = this.history.map(encodePastedLines);

    const controller = new AbortController();
    let closed = false;
    const onClose = () => {
      closed = true;
      controller.abort();
    };
    const onInterrupt = () => readline.close();
    readline.once("close", onClose);
    readline.on("SIGINT", onInterrupt);

    try {
      const answer = await readline.question(prompt, {
        signal: controller.signal,
      });
      this.history = readline.history
        .slice(0, this.historySize)
        .map(decodePastedLines);
      return decodePastedLines(answer);
    } catch (error) {
      if (closed || error?.name === "AbortError") {
        return null;
      }
      throw error;
    } finally {
      readline.removeListener("close", onClose);
      readline.removeListener("SIGINT", onInterrupt);
      readline.close();
      this.outputStream.write(DISABLE_BRACKETED_PASTE);
      this.outputStream.write(DISABLE_KITTY_KEYBOARD);
      this.inputStream.unpipe(pasteInput);
      pasteInput.destroy();
    }
  }

  close() {
    // Each readline instance is scoped to one question and is closed in read().
    // This method keeps ownership explicit for callers and future extensions.
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
