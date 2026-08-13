import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  classifyChatInput,
  promptForSelect,
  promptForText,
  readChatMessage,
  ShellChatInput,
} from "../src/cli/prompt-input.js";

function createTtyStream() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = 80;
  stream.setRawMode = () => {};
  return stream;
}

test("Ctrl+D EOF exits an active prompt", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const pending = promptForText(
    { message: "you ›" },
    { inputStream, outputStream },
  );

  inputStream.end();

  const result = await Promise.race([
    pending,
    new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error("prompt did not exit after EOF")),
        500,
      );
    }),
  ]);
  assert.equal(result, null);
});

test("Ctrl+C prompt rejection is a clean exit", async () => {
  const error = new Error("closed");
  error.name = "ExitPromptError";

  const result = await promptForText(
    { message: "you ›" },
    {
      prompt: async () => {
        throw error;
      },
    },
  );

  assert.equal(result, null);
});

test("unexpected prompt failures still surface", async () => {
  await assert.rejects(
    promptForText(
      { message: "you ›" },
      {
        prompt: async () => {
          throw new Error("boom");
        },
      },
    ),
    /boom/,
  );
});

test("select prompts share the same clean-exit handling", async () => {
  const result = await promptForSelect(
    { message: "ChatGPT mode", choices: [] },
    { prompt: async () => "current" },
  );

  assert.equal(result, "current");
});

test("blank chat input re-prompts instead of exiting", () => {
  assert.deepEqual(classifyChatInput("   "), {
    kind: "empty",
    text: "",
  });
});

test("only explicit commands classify as chat exit", () => {
  assert.equal(classifyChatInput("exit").kind, "exit");
  assert.equal(classifyChatInput("/quit").kind, "exit");
  assert.deepEqual(classifyChatInput("continue"), {
    kind: "message",
    text: "continue",
  });
});

test("initial chat input skips blanks until a real task arrives", async () => {
  const answers = ["", "   ", "build a site"];

  const message = await readChatMessage(async () => answers.shift());

  assert.equal(message, "build a site");
  assert.equal(answers.length, 0);
});

test("initial chat input exits without creating a task on an exit command", async () => {
  assert.equal(await readChatMessage(async () => "exit"), null);
});

test("shell chat input recalls previous messages with the up arrow", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const first = chatInput.read();
  inputStream.write("first message\n");
  assert.equal(await first, "first message");

  const recalled = chatInput.read();
  inputStream.write("\u001b[A\n");
  assert.equal(await recalled, "first message");
});

test("shell chat input supports up and down history navigation", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });
  chatInput.remember("first");
  chatInput.remember("second");

  const selected = chatInput.read();
  inputStream.write("\u001b[A\u001b[A\u001b[B\n");

  assert.equal(await selected, "second");
});

test("shell chat input keeps a bracketed multiline paste as one message", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  let settled = false;
  const pending = chatInput.read().then((value) => {
    settled = true;
    return value;
  });
  inputStream.write(
    "\u001b[200~first line\r\nsecond line\nthird line\u001b[201~",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "paste must not submit before a separate Enter");

  inputStream.write("\n");
  assert.equal(await pending, "first line\nsecond line\nthird line");
});

test("shell chat input recognizes an unbracketed multiline paste in one chunk", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const pending = chatInput.read();
  inputStream.write("first line\nsecond line\nthird line");
  inputStream.write("\n");

  assert.equal(await pending, "first line\nsecond line\nthird line");
});

test("shell chat history preserves multiline pasted messages", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });
  chatInput.remember("first line\nsecond line");

  const pending = chatInput.read();
  inputStream.write("\u001b[A\n");

  assert.equal(await pending, "first line\nsecond line");
});

test("shell chat input exits cleanly on Ctrl+D", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const pending = chatInput.read();
  inputStream.end();

  assert.equal(await pending, null);
});

test("shell chat input exits cleanly on Ctrl+C", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const pending = chatInput.read();
  inputStream.write("\u0003");

  assert.equal(await pending, null);
});


test("shell chat input turns Shift+Enter into a newline instead of submitting", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const pending = chatInput.read();
  inputStream.write("line one\u001b[13;2uline two\r");

  assert.equal(await pending, "line one\nline two");
});

test("shell chat input keeps a Shift+Enter sequence split across chunks", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const pending = chatInput.read();
  inputStream.write("line one\u001b[13;");
  inputStream.write("2u");
  inputStream.write("line two\r");

  assert.equal(await pending, "line one\nline two");
});

test("shell chat input asks the terminal to disambiguate Shift+Enter via kitty protocol", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  let rendered = "";
  outputStream.on("data", (chunk) => {
    rendered += chunk.toString("utf8");
  });
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const pending = chatInput.read();
  inputStream.write("hello\r");
  await pending;

  assert.match(rendered, /\u001b\[>1u/);
  assert.match(rendered, /\u001b\[<1u/);
});
