import { input, select } from "@inquirer/prompts";
import { createInterface } from "node:readline/promises";

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

    const readline = createInterface({
      input: this.inputStream,
      output: this.outputStream,
      terminal: true,
      historySize: this.historySize,
      removeHistoryDuplicates: true,
    });
    readline.history = [...this.history];

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
      this.history = readline.history.slice(0, this.historySize);
      return answer;
    } catch (error) {
      if (closed || error?.name === "AbortError") {
        return null;
      }
      throw error;
    } finally {
      readline.removeListener("close", onClose);
      readline.removeListener("SIGINT", onInterrupt);
      readline.close();
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
