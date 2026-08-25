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
  inputStream.write("first message\r");
  assert.equal(await first, "first message");

  const recalled = chatInput.read();
  inputStream.write("\u001b[A\r");
  assert.equal(await recalled, "first message");
});

test("shell chat input supports up and down history navigation", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });
  chatInput.remember("first");
  chatInput.remember("second");

  const selected = chatInput.read();
  inputStream.write("\u001b[A\u001b[A\u001b[B\r");

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

  inputStream.write("\r");
  assert.equal(await pending, "first line\nsecond line\nthird line");
});

test("shell chat input recognizes an unbracketed multiline paste in one chunk", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const pending = chatInput.read();
  inputStream.write("first line\nsecond line\nthird line");
  inputStream.write("\r");

  assert.equal(await pending, "first line\nsecond line\nthird line");
});

test("shell chat history preserves multiline pasted messages", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });
  chatInput.remember("first line\nsecond line");

  const pending = chatInput.read();
  inputStream.write("\u001b[A\r");

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

test("shell chat input treats xterm modifyOtherKeys Shift+Enter as a newline", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const pending = chatInput.read();
  inputStream.write("line one\u001b[27;2;13~line two\r");

  assert.equal(await pending, "line one\nline two");
});

test("cursor stays on the last line after a Shift+Enter newline insert", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  let rendered = "";
  outputStream.on("data", (chunk) => {
    rendered += chunk.toString("utf8");
  });
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const pending = chatInput.read();
  inputStream.write("ab\u001b[13;2uc\r");
  assert.equal(await pending, "ab\nc");

  // Drawing ends at the last rendered line ("c"); the cursor already sits on
  // that line, so its placement must be a plain CR + column move. A wrong
  // cursor-up here would make the NEXT redraw wipe the line above the prompt.
  assert.ok(rendered.includes("c\r\u001b[1C"), "cursor placed via CR + column");
  assert.ok(
    !rendered.includes("c\u001b[1A"),
    "cursor must not move up after drawing the last line",
  );
});

test("wraps input width from the output stream, not the column-less input stream", async () => {
  // Regression: terminal width lives on the TTY output stream. Reading
  // inputStream.columns (always undefined for stdin) fell back to 80, wrapping
  // CJK input after ~40 chars and corrupting arrow-key redraws. A wide output
  // terminal must keep a short CJK line on a single drawn row.
  const inputStream = createTtyStream();
  delete inputStream.columns; // stdin has no columns, like real process.stdin
  const outputStream = createTtyStream();
  outputStream.columns = 200;
  let rendered = "";
  outputStream.on("data", (chunk) => {
    rendered += chunk.toString("utf8");
  });
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const pending = chatInput.read();
  // 50 CJK chars = 100 display columns: with the 7-col " you › " prompt this
  // overflows the old 80-col stdin fallback (wrapping to ~15 rows) but fits on
  // one row at 200. Must clear 80 by a real margin — 30 chars (60 cols) fit
  // under both widths and would make this test pass even with the bug present.
  inputStream.write("的".repeat(50) + "\r");
  assert.equal(await pending, "的".repeat(50));

  // The discriminator: wrapping to multiple rows forces cursor-up escapes
  // (\x1b[<n>A) into every redraw — the motion that duplicated input up the
  // screen. A single drawn row never emits one. (Do not assert on "\r\n的":
  // render writes "\r\n" then a clear-line "\x1b[2K" before the text, so that
  // substring can never appear and the assertion would be vacuous.)
  assert.ok(
    !/\x1b\[\d+A/.test(rendered),
    "wide terminal must keep short CJK input on one row (no cursor-up redraw)",
  );
});

test("arrow-key redraws never scroll a wrapped input above its home row", async () => {
  // Regression for the "content scrolls/duplicates upward" bug: render() began
  // each redraw by moving up `linesDrawn - 1` to reach the block's top row. But
  // after arrowing left into an earlier WRAPPED row the cursor sits at
  // `cursorRow` (above the bottom), so that move overshoots ABOVE the prompt,
  // erasing the scrollback line above it and shifting the whole block up on
  // every keystroke. The fix moves up by the true `cursorRow` instead.
  //
  // Replay the editor's own escape stream through a tiny vertical-position
  // tracker: relative row 0 is the prompt's home line. A correct redraw never
  // drives the cursor negative (above home); the bug does exactly that.
  const inputStream = createTtyStream();
  delete inputStream.columns;
  const outputStream = createTtyStream();
  outputStream.columns = 88; // wide enough to need two rows, not fifteen
  let minRow = 0;
  let row = 0;
  outputStream.on("data", (chunk) => {
    const bytes = chunk.toString("utf8");
    for (let i = 0; i < bytes.length; i += 1) {
      if (bytes[i] === "\n") {
        row += 1;
        continue;
      }
      if (bytes[i] === "\x1b" && bytes[i + 1] === "[") {
        let j = i + 2;
        let params = "";
        while (j < bytes.length && /[0-9;>?]/.test(bytes[j])) {
          params += bytes[j];
          j += 1;
        }
        const n = parseInt(params, 10);
        const num = Number.isNaN(n) ? 1 : n;
        if (bytes[j] === "A") row -= num;
        else if (bytes[j] === "B") row += num;
        i = j; // skip the consumed CSI
        if (row < minRow) minRow = row;
      }
    }
  });
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const pending = chatInput.read();
  // Long enough to wrap to THREE rows at 88 cols so the cursor can land on a
  // MIDDLE row — where the buggy `linesDrawn - 1` up-move overshoots the home
  // line. A two-row message keeps the cursor on the bottom row and hides it.
  const message =
    "分析 review/seo 下的内容 和本项目。 你需要进一步补充信息。 给出一个全面的 seo 优化方案。";
  inputStream.write(message);
  // Arrow left across the wrap boundary and back out; each press triggers a
  // full redraw whose vertical moves must stay at or below the home row.
  const LEFT = "[D";
  const RIGHT = "[C";
  inputStream.write((LEFT.repeat(40) + RIGHT.repeat(40)));
  await new Promise((resolve) => setImmediate(resolve));
  inputStream.write("\r");
  assert.equal(await pending, message);

  assert.ok(
    minRow >= 0,
    `redraw moved ${-minRow} row(s) above the prompt's home line — ` +
      "wrapped input would scroll/duplicate up the screen",
  );
});

test("shell chat input treats ESC+CR Shift+Enter as a newline", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const pending = chatInput.read();
  inputStream.write("line one\u001b\rline two\r");

  assert.equal(await pending, "line one\nline two");
});

test("shell chat input treats Ctrl+J as a newline instead of submitting", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  let settled = false;
  const pending = chatInput.read().then((value) => {
    settled = true;
    return value;
  });
  inputStream.write("line one\nline two");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "Ctrl+J must insert a newline instead of submitting");

  inputStream.write("\r");
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

test("shell chat input pauses stdin after reading so lingering keypress listeners cannot pin the process", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  // Simulate readline's keypress machinery still holding its internal 'data'
  // listener on stdin (as left behind by the adapter's ESC-cancel attach):
  // keep a keypress listener registered so that listener never self-removes.
  const { emitKeypressEvents } = await import("node:readline");
  emitKeypressEvents(inputStream);
  const onKeypress = () => {};
  inputStream.on("keypress", onKeypress);

  const chatInput = new ShellChatInput({ inputStream, outputStream });
  const pending = chatInput.read();
  inputStream.write("hello\r");

  assert.equal(await pending, "hello");
  assert.equal(
    inputStream.isPaused(),
    true,
    "stdin must be paused after the prompt ends or the process cannot exit",
  );
  inputStream.removeListener("keypress", onKeypress);
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
  assert.match(rendered, /\u001b\[>4;2m/);
  assert.match(rendered, /\u001b\[>4;0m/);
  assert.match(rendered, /\u001b\[<1u/);
});
