import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAgentResponse,
  serializeToolResult,
} from "../src/protocol/xml-protocol.js";

test("parses a tool call with CDATA and item arrays", () => {
  const parsed = parseAgentResponse(`
<agent_response>
  <done>false</done>
  <message>writing</message>
  <tool_call id="call_1" name="terminal.exec">
    <args>
      <program>npm</program>
      <argv><item>run</item><item>build</item></argv>
      <snippet><![CDATA[const x = "<tag>";]]></snippet>
    </args>
  </tool_call>
</agent_response>`);

  assert.equal(parsed.done, false);
  assert.equal(parsed.toolCall.name, "terminal.exec");
  assert.deepEqual(parsed.toolCall.args.argv, ["run", "build"]);
  assert.equal(parsed.toolCall.args.snippet, 'const x = "<tag>";');
});

test("accepts a single xml code fence", () => {
  const parsed = parseAgentResponse(`
\`\`\`xml
<agent_response>
  <done>true</done>
  <message>done</message>
</agent_response>
\`\`\`
`);
  assert.equal(parsed.done, true);
  assert.equal(parsed.message, "done");
});

test("normalizes an empty args element to an object", () => {
  const parsed = parseAgentResponse(`
<agent_response>
  <done>false</done>
  <message>list</message>
  <tool_call id="call_empty" name="fs.list"><args/></tool_call>
</agent_response>`);

  assert.deepEqual(parsed.toolCall.args, {});
});

test("accepts a model tool call without a call id", () => {
  const parsed = parseAgentResponse(`
<agent_response>
  <done>false</done>
  <tool_call name="fs.list"><args/></tool_call>
</agent_response>`);

  assert.equal(parsed.toolCall.id, null);
});

test("accepts child name and arguments aliases", () => {
  const parsed = parseAgentResponse(`
<agent_response>
  <done>false</done>
  <tool_call>
    <name>fs.write</name>
    <arguments>
      <path>package.json</path>
      <content><![CDATA[{"name":"todo"}]]></content>
    </arguments>
  </tool_call>
</agent_response>`);

  assert.equal(parsed.toolCall.name, "fs.write");
  assert.deepEqual(parsed.toolCall.args, {
    path: "package.json",
    content: '{"name":"todo"}',
  });
});

test("allows an HTML doctype inside CDATA", () => {
  const parsed = parseAgentResponse(`
<agent_response>
  <done>false</done>
  <tool_call name="fs.write">
    <args>
      <path>index.html</path>
      <content><![CDATA[<!doctype html><html></html>]]></content>
    </args>
  </tool_call>
</agent_response>`);

  assert.equal(
    parsed.toolCall.args.content,
    "<!doctype html><html></html>",
  );
});

test("normalizes a formatted single-item argv list", () => {
  const parsed = parseAgentResponse(`
<agent_response>
  <done>false</done>
  <tool_call>
    <name>terminal.exec</name>
    <arguments>
      <program>npm</program>
      <argv>
        <item>install</item>
      </argv>
    </arguments>
  </tool_call>
</agent_response>`);

  assert.deepEqual(parsed.toolCall.args.argv, ["install"]);
});

test("strips text surrounding the envelope", () => {
  const parsed = parseAgentResponse(
    "Sure, here is the response:\n<agent_response><done>true</done><message>x</message></agent_response>\nLet me know if that helps!",
  );
  assert.equal(parsed.done, true);
  assert.equal(parsed.message, "x");
});

test("repairs bare ampersands in message text", () => {
  const parsed = parseAgentResponse(
    `<agent_response><done>true</done><message>Tom & Jerry, R&D, url a=1&b=2</message></agent_response>`,
  );
  assert.equal(parsed.done, true);
  assert.equal(parsed.message, "Tom & Jerry, R&D, url a=1&b=2");
});

test("repairs bare ampersands in tool argument values", () => {
  const parsed = parseAgentResponse(
    `<agent_response><done>false</done><tool_call name="fs.write"><args><path>a&b.txt</path><content>x</content></args></tool_call></agent_response>`,
  );
  assert.equal(parsed.toolCall.args.path, "a&b.txt");
  assert.equal(parsed.toolCall.args.content, "x");
});

test("leaves valid entities and CDATA ampersands intact", () => {
  const parsed = parseAgentResponse(
    `<agent_response><done>false</done><tool_call name="fs.write"><args><path>i.html</path><content><![CDATA[<a href="x?a=1&b=2">5 &lt; 6</a>]]></content><note>5 &lt; 6 &amp; 7</note></args></tool_call></agent_response>`,
  );
  // CDATA content is byte-for-byte preserved.
  assert.equal(
    parsed.toolCall.args.content,
    '<a href="x?a=1&b=2">5 &lt; 6</a>',
  );
  // A valid entity outside CDATA is decoded normally, not double-escaped.
  assert.equal(parsed.toolCall.args.note, "5 < 6 & 7");
});

test("recovers a message-only answer when inner markup is broken", () => {
  const parsed = parseAgentResponse(
    `<agent_response><done>true</done><message>Here is <b>bold that never closes and a<c stray bracket</message></agent_response>`,
  );
  assert.equal(parsed.done, true);
  assert.equal(parsed.recovered, true);
  assert.match(parsed.message, /bold that never closes/);
});

test("does not recover a tool call from broken XML", () => {
  assert.throws(
    () => parseAgentResponse(
      `<agent_response><done>false</done><tool_call name="fs.write"><args><path>a.txt<content>oops</args></tool_call></agent_response>`,
    ),
    /Invalid XML/,
  );
});

test("rejects done=true with a tool call", () => {
  assert.throws(
    () => parseAgentResponse(`
<agent_response>
  <done>true</done>
  <message>x</message>
  <tool_call name="fs.read"><args><path>a</path></args></tool_call>
</agent_response>`),
    /cannot also request a tool/,
  );
});

test("serializes a sequential tool result without exposing an internal call id", () => {
  const xml = serializeToolResult({
    callId: "call_1",
    name: "terminal.exec",
    ok: false,
    message: "failed",
    stderr: "bad <token>",
  });
  assert.doesNotMatch(xml, /call_id=/);
  assert.match(xml, /status="error"/);
  assert.match(xml, /<!\[CDATA\[bad <token>\]\]>/);
});

test("serializes oversized tool data within a UTF-8 byte budget", () => {
  const maxBytes = 12 * 1024;
  const xml = serializeToolResult({
    name: "fs.list",
    ok: true,
    message: "Listed entries.",
    data: {
      entries: Array.from(
        { length: 2_000 },
        (_, index) => `路径-${index}-${"中".repeat(20)}`,
      ),
    },
  }, { maxBytes });

  assert.ok(Buffer.byteLength(xml, "utf8") <= maxBytes);
  assert.match(xml, /<tool_result[^>]+truncated="true"/);
  assert.match(xml, /WTAgent omitted/);
  assert.match(xml, /<\/tool_result>$/);
  assert.doesNotMatch(xml, /�/);
});
