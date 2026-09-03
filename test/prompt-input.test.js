import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  charWidth,
  classifyChatInput,
  displayWidth,
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

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Replay editor ANSI into a cell grid so wrap/unwrap tests can assert the
// visible screen, not just the escape soup. Wide glyphs occupy two cells;
// CSI-2K / ED 0 / CUU / CUD / CUF / CUB / CR / LF are applied in order.
function replayAnsi(bytes, { columns = 80, rows = 12 } = {}) {
  const screen = Array.from({ length: rows }, () => Array(columns).fill(" "));
  let row = 0;
  let col = 0;
  let autowrap = true;
  const text = String(bytes);
  let index = 0;
  while (index < text.length) {
    const current = text[index];
    if (current === "\r") {
      col = 0;
      index += 1;
      continue;
    }
    if (current === "\n") {
      row = Math.min(rows - 1, row + 1);
      index += 1;
      continue;
    }
    if (current === "\u001b" && text[index + 1] === "[") {
      let cursor = index + 2;
      while (
        cursor < text.length
        && text.charCodeAt(cursor) >= 0x30
        && text.charCodeAt(cursor) <= 0x3F
      ) {
        cursor += 1;
      }
      while (
        cursor < text.length
        && text.charCodeAt(cursor) >= 0x20
        && text.charCodeAt(cursor) <= 0x2F
      ) {
        cursor += 1;
      }
      const command = text[cursor] ?? "";
      const params = text.slice(index + 2, cursor);
      const numeric = params.replace(/^[?<>]/, "")
        .split(";")
        .filter((part) => part.length > 0)
        .map(Number);
      if (command === "A") {
        row = Math.max(0, row - (numeric[0] || 1));
      } else if (command === "B") {
        row = Math.min(rows - 1, row + (numeric[0] || 1));
      } else if (command === "C") {
        col = Math.min(columns - 1, col + (numeric[0] || 1));
      } else if (command === "D") {
        col = Math.max(0, col - (numeric[0] || 1));
      } else if (command === "K") {
        const mode = numeric[0] ?? 0;
        const start = mode === 1 ? 0 : mode === 2 ? 0 : col;
        const end = mode === 1 ? col : columns;
        for (let x = start; x < end; x += 1) {
          screen[row][x] = " ";
        }
      } else if (command === "J") {
        const mode = numeric[0] ?? 0;
        if (mode === 0) {
          for (let x = col; x < columns; x += 1) {
            screen[row][x] = " ";
          }
          for (let y = row + 1; y < rows; y += 1) {
            screen[y].fill(" ");
          }
        }
      } else if (command === "l" && params.startsWith("?7")) {
        autowrap = false;
      } else if (command === "h" && params.startsWith("?7")) {
        autowrap = true;
      }
      index = cursor + 1;
      continue;
    }
    if (current === "\u001b") {
      index += 2;
      continue;
    }
    const codePoint = text.codePointAt(index);
    const glyph = String.fromCodePoint(codePoint);
    const width = charWidth(codePoint);
    index += glyph.length;
    if (width <= 0) {
      continue;
    }
    if (autowrap && col + width > columns) {
      row = Math.min(rows - 1, row + 1);
      col = 0;
    }
    if (row < rows && col < columns) {
      screen[row][col] = glyph;
      if (width === 2 && col + 1 < columns) {
        screen[row][col + 1] = "";
      }
    }
    col += width;
    if (!autowrap && col >= columns) {
      col = columns - 1;
    }
  }
  return {
    autowrap,
    lines: screen.map((cells) => cells.join("").trimEnd()),
  };
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
  // ED 0 (`\x1b[J`) may sit between the glyph and the CR: it erases leftover
  // wrap rows below the block and must not be mistaken for a cursor-up.
  assert.match(rendered, /c(?:\u001b\[J)?\r\u001b\[1C/);
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
  assert.match(rendered, /\u001b\[\?7l/);
  assert.match(rendered, /\u001b\[\?7h/);
});

test("CJK and combining marks use East-Asian terminal cell widths", () => {
  assert.equal(charWidth("中".codePointAt(0)), 2);
  assert.equal(charWidth("の".codePointAt(0)), 2);
  assert.equal(charWidth("한".codePointAt(0)), 2);
  assert.equal(charWidth(0xA960), 2);
  assert.equal(charWidth("🚀".codePointAt(0)), 2);
  assert.equal(charWidth("a".codePointAt(0)), 1);
  // Ambiguous (U+203A ›) must stay width 1: prompt 7 cells is ODD, CJK is 2,
  // so the cursor after any CJK run sits on a glyph's LEADING cell. Widening ›
  // makes the prompt even and the cursor lands on TRAILING cells, which macOS
  // Terminal.app refuses to draw — the cursor blinks out while typing Chinese.
  assert.equal(charWidth("›".codePointAt(0)), 1);
  assert.equal(charWidth("“".codePointAt(0)), 1);
  assert.equal(charWidth("́".codePointAt(0)), 0);
  assert.equal(displayWidth("你好"), 4);
  assert.equal(displayWidth(" you › "), 7);
  assert.equal(displayWidth(" you › ") % 2, 1, "prompt width must stay odd so CJK cursors sit on leading cells");
});

test("CJK wrap leaves the last column empty so the terminal cannot XENL", async () => {
  // Prompt is 7 cols. At width 21 the old `> width` wrap parked 7 CJK (14 cols)
  // in the last cell of row 0 and the terminal then wrapped onto a phantom
  // row. `>= width` keeps a spare cell: 6 CJK on row 0, the 7th on row 1.
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  outputStream.columns = 21;
  let rendered = "";
  outputStream.on("data", (chunk) => {
    rendered += chunk.toString("utf8");
  });
  const chatInput = new ShellChatInput({ inputStream, outputStream });
  const pending = chatInput.read();
  inputStream.write("的".repeat(7));
  await tick();

  const { lines } = replayAnsi(rendered, { columns: 21, rows: 6 });
  assert.equal(lines[0], ` you › ${"的".repeat(6)}`);
  assert.equal(lines[1], "的");
  assert.equal(lines[2], "");

  inputStream.write("\r");
  assert.equal(await pending, "的".repeat(7));
});

test("CJK backspace after wrap erases the leftover row instead of leaving a ghost glyph", async () => {
  // The user-visible bug: wrap to two rows, delete the last CJK, the buffer
  // drops the glyph but the extra row still showed it. Shrink must ED 0 from
  // the last content line so the stale row is blank, and submit the shorter
  // string — display and buffer stay in lockstep.
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  outputStream.columns = 21;
  let rendered = "";
  outputStream.on("data", (chunk) => {
    rendered += chunk.toString("utf8");
  });
  const chatInput = new ShellChatInput({ inputStream, outputStream });
  const pending = chatInput.read();
  inputStream.write("的".repeat(7));
  await tick();
  inputStream.write("\u007f");
  await tick();
  const afterBackspace = rendered;

  assert.match(afterBackspace, /\u001b\[J/, "unwrap must erase below the last content line");

  const { lines } = replayAnsi(afterBackspace, { columns: 21, rows: 6 });
  assert.equal(lines[0], ` you › ${"的".repeat(6)}`);
  assert.equal(lines[1], "", "deleted CJK must not remain on the leftover wrap row");
  assert.ok(
    !lines.some((line) => (line.match(/的/g) || []).length > 6),
    "screen must not keep a 7th 的 after backspace",
  );

  inputStream.write("\r");
  assert.equal(await pending, "的".repeat(6));
});

test("CJK insert in the middle of a wrapped line does not duplicate glyphs on screen", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  outputStream.columns = 21;
  let rendered = "";
  outputStream.on("data", (chunk) => {
    rendered += chunk.toString("utf8");
  });
  const chatInput = new ShellChatInput({ inputStream, outputStream });
  const pending = chatInput.read();
  inputStream.write("的".repeat(6));
  await tick();
  // Left across 3 CJK (each a single code point), insert one more, return to end.
  inputStream.write("\u001b[D".repeat(3) + "中" + "\u001b[C".repeat(3));
  await tick();

  const { lines } = replayAnsi(rendered, { columns: 21, rows: 6 });
  const visible = lines.join("").replace(/ you › /g, "");
  const glyphs = [...visible].filter((ch) => ch === "的" || ch === "中");
  assert.deepEqual(glyphs, ["的", "的", "的", "中", "的", "的", "的"]);

  inputStream.write("\r");
  assert.equal(await pending, "的的的中的的的");
});

test("CJK code points survive being split across TTY chunks", async () => {
  // 的 is E7 9A 84. A real TTY can deliver those bytes in two reads; without
  // StringDecoder the editor would insert replacement chars and the buffer
  // would no longer match what the user typed.
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  const chatInput = new ShellChatInput({ inputStream, outputStream });
  const pending = chatInput.read();
  inputStream.write(Buffer.from([0xe7, 0x9a]));
  await tick();
  inputStream.write(Buffer.from([0x84]));
  await tick();
  inputStream.write("\r");
  assert.equal(await pending, "的");
});

test("CJK backspace in the middle of a wrapped line keeps buffer and screen aligned", async () => {
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  outputStream.columns = 21;
  let rendered = "";
  outputStream.on("data", (chunk) => {
    rendered += chunk.toString("utf8");
  });
  const chatInput = new ShellChatInput({ inputStream, outputStream });
  const pending = chatInput.read();
  inputStream.write("的".repeat(7));
  await tick();
  // Cursor is at the end (row 1). Move left twice onto the last two CJK, then
  // backspace — that deletes the 6th 的, leaving six glyphs that fit on one
  // row. Screen and buffer must both drop the deleted character.
  inputStream.write("\u001b[D".repeat(2) + "\u007f");
  await tick();

  const { lines } = replayAnsi(rendered, { columns: 21, rows: 6 });
  const glyphs = [...lines.join("")].filter((ch) => ch === "的");
  assert.deepEqual(glyphs, ["的", "的", "的", "的", "的", "的"]);
  assert.equal(lines[0], ` you › ${"的".repeat(6)}`);
  assert.equal(lines[1], "");

  inputStream.write("\r");
  assert.equal(await pending, "的".repeat(6));
});

test("CJK wraps when only one cell remains on an ASCII line", async () => {
  // Prompt 7 + 13 ASCII = 20 of 21. Remaining 1 cell cannot hold a width-2
  // CJK glyph; it must start the next row instead of overflowing the edge.
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  outputStream.columns = 21;
  let rendered = "";
  outputStream.on("data", (chunk) => {
    rendered += chunk.toString("utf8");
  });
  const chatInput = new ShellChatInput({ inputStream, outputStream });
  const pending = chatInput.read();
  inputStream.write(`${"a".repeat(13)}中`);
  await tick();

  const { lines } = replayAnsi(rendered, { columns: 21, rows: 6 });
  assert.equal(lines[0], ` you › ${"a".repeat(13)}`);
  assert.equal(lines[1], "中");

  inputStream.write("\r");
  assert.equal(await pending, `${"a".repeat(13)}中`);
});

test("cursor column stays odd (leading cell) after pure CJK typing", async () => {
  // Regression for the "cursor blinks in and out" bug: with an even prompt
  // width (› counted as 2) or an off-by-one row-prefix the cursor column
  // after any CJK glyph is EVEN = the glyph's TRAILING cell. macOS Terminal.app
  // does not draw the cursor on a trailing cell, so it appeared to blink out
  // while typing Chinese. The 7-cell prompt (odd) + width-2 CJK keeps every
  // column odd = leading cell always.
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  outputStream.columns = 80;
  let rendered = "";
  outputStream.on("data", (chunk) => {
    rendered += chunk.toString("utf8");
  });
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const pending = chatInput.read();
  inputStream.write("的".repeat(5));
  await tick();

  // The final cursor motion emitted by render() is `\r` CUF <n>. Check every
  // CUF emitted after a CR directly (the render's last motion) has odd col.
  const cufs = [...rendered.matchAll(/\r\[(\d+)C/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  assert.ok(cufs.length > 0, "redraws must position the cursor with CUF");
  for (const col of cufs) {
    assert.ok(
      col % 2 === 1,
      `cursor column ${col} is even = trailing cell; Terminal.app hides it`,
    );
  }

  inputStream.write("\r");
  assert.equal(await pending, "的".repeat(5));
});

test("cursor column stays odd on every row of a multiline CJK message", async () => {
  // Second half of the blink bug: after a Shift+Enter newline the row range
  // used to include the "\n", so the prefix width was +1 and the column
  // landed on the trailing cell of the first CJK on the new row.
  const inputStream = createTtyStream();
  const outputStream = createTtyStream();
  outputStream.columns = 80;
  let rendered = "";
  outputStream.on("data", (chunk) => {
    rendered += chunk.toString("utf8");
  });
  const chatInput = new ShellChatInput({ inputStream, outputStream });

  const pending = chatInput.read();
  inputStream.write("中文[13;2u的");
  await tick();

  const cufs = [...rendered.matchAll(/\r\[(\d+)C/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  assert.ok(cufs.length > 0, "redraws must position the cursor with CUF");
  const last = cufs[cufs.length - 1];
  // Row 2 starts at column 0 (no prompt). Cursor after "的" is at its leading
  // cell: col 2 (the glyph's own width). An off-by-one row prefix would have
  // produced col 3 (trailing cell of a 2-cell glyph) — the blink bug.
  assert.equal(last, 2, "cursor after 的 on row 2 must sit on its leading cell (col 2)");

  inputStream.write("\r");
  assert.equal(await pending, "中文\n的");
});
