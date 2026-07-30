import assert from "node:assert/strict";
import test from "node:test";

import { Renderer } from "../src/cli/render-events.js";

function captureStream() {
  let output = "";
  return {
    isTTY: false,
    write(chunk) {
      output += String(chunk);
    },
    output() {
      return output;
    },
  };
}

test("prints browser and conversation lifecycle status only once per CLI session", () => {
  const stream = captureStream();
  const renderer = new Renderer({ stream });

  renderer.handle({ type: "browser.started" });
  renderer.handle({
    type: "conversation.started",
    payload: { mode: "Pro" },
  });
  renderer.handle({ type: "browser.started" });
  renderer.handle({
    type: "conversation.started",
    payload: { mode: "Pro" },
  });

  const output = stream.output();
  assert.equal(output.match(/Chrome started\./g)?.length, 1);
  assert.equal(output.match(/Conversation ready \(Pro\)\./g)?.length, 1);
});

test("keeps non-lifecycle events visible on later turns", () => {
  const stream = captureStream();
  const renderer = new Renderer({ stream });

  renderer.handle({ type: "browser.started" });
  renderer.handle({ type: "browser.started" });
  renderer.handle({
    type: "conversation.mode_selected",
    payload: {
      requested: "Pro",
      status: "unavailable",
      selectedLabel: null,
    },
  });

  assert.match(
    stream.output(),
    /Mode: could not select Pro; continuing on current mode\./,
  );
});
