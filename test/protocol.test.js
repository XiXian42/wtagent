import test from "node:test";
import assert from "node:assert/strict";
import {
  extractTrailingProse,
  parseAgentResponse,
  serializeProtocolError,
  serializeToolResult,
  stripUiNoiseLines,
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

test("extractTrailingProse returns the substantive answer that follows the envelope", () => {
  const trailing = extractTrailingProse(
    "思考过程\nxml\n<agent_response><done>true</done><message>已完成代码审查</message></agent_response>\n应用分析报告：sweep\n概述\n一个 Swift 磁盘清理工具",
  );
  assert.equal(trailing, "应用分析报告：sweep\n概述\n一个 Swift 磁盘清理工具");
});

test("extractTrailingProse strips only leading UI-noise lines", () => {
  // "运行" appears as a leading action-button label (stripped), while the word
  // also occurs inside the real content (kept).
  const trailing = extractTrailingProse(
    "<agent_response><done>true</done></agent_response>\n复制\n下载\n运行\n报告：需要运行 npm install",
  );
  assert.equal(trailing, "报告：需要运行 npm install");
});

test("extractTrailingProse returns null when there is no envelope or the reply is duplicated", () => {
  assert.equal(extractTrailingProse("just prose, no envelope"), null);
  assert.equal(
    extractTrailingProse(
      "<agent_response><done>true</done></agent_response>\n<agent_response>x</agent_response>",
    ),
    null,
    "a duplicated render of the envelope cannot be separated from real content",
  );
  assert.equal(
    extractTrailingProse("<agent_response><done>true</done></agent_response>\n复制\n下载"),
    null,
    "pure UI noise after the envelope is not substantive",
  );
});

test("stripUiNoiseLines strips provider chrome from a plain answer", () => {
  assert.equal(
    stripUiNoiseLines("思考过程\nxml\n跳过\n\n我做不到，因为…"),
    "我做不到，因为…",
  );
  assert.equal(
    stripUiNoiseLines("正常回答，不含噪音"),
    "正常回答，不含噪音",
  );
});

test("stripUiNoiseLines strips UI chrome in other locales", () => {
  assert.equal(
    stripUiNoiseLines("Thinking\nCopy code\n\nI can help with that"),
    "I can help with that",
  );
  assert.equal(
    stripUiNoiseLines("考え中\nコピー\n\n回答です"),
    "回答です",
  );
  // Case-insensitive for the ascii tokens.
  assert.equal(
    stripUiNoiseLines("Reasoning\nSkip\nDone: yes"),
    "Done: yes",
  );
});

test("keeps the first envelope when the same reply is rendered twice", () => {
  const envelope = `
<agent_response>
  <done>false</done>
  <message>我先查看项目结构，确定应用类型和关键源码位置。</message>
  <tool_call name="fs.list">
    <args><path>.</path><depth>3</depth><include_hidden>false</include_hidden></args>
  </tool_call>
</agent_response>`;
  const parsed = parseAgentResponse(`xml\n复制${envelope}\nxml\n复制${envelope}`);
  assert.equal(parsed.done, false);
  assert.equal(parsed.toolCall.name, "fs.list");
  assert.equal(parsed.toolCall.args.path, ".");
  assert.equal(parsed.toolCall.args.depth, "3");
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

test("wraps a Claude-style invoke in an agent_response envelope", () => {
  const parsed = parseAgentResponse(`
Let me read the README.
<tool_calls>
<invoke name="fs.read">
<parameter name="path">README.md</parameter>
</invoke>
</tool_calls>`);
  assert.equal(parsed.done, false);
  assert.equal(parsed.toolCall.name, "fs.read");
  assert.equal(parsed.toolCall.args.path, "README.md");
});

test("wraps a bare tool_call in an agent_response envelope", () => {
  const parsed = parseAgentResponse(`
<tool_call name="fs.read">
<args><path>package.json</path><offset>0</offset><max_bytes>16384</max_bytes></args>
</tool_call>`);
  assert.equal(parsed.done, false);
  assert.equal(parsed.toolCall.name, "fs.read");
  assert.equal(parsed.toolCall.args.path, "package.json");
});

test("repairs a missing </tool_call> before </agent_response>", () => {
  const parsed = parseAgentResponse(`
思考过程
xml
<agent_response>
  <done>false</done>
  <message>Reading TreeWalker.</message>
  <tool_call name="fs.read">
    <args><path>Sources/SweepKit/TreeWalker.swift</path><offset>0</offset><max_bytes>16384</max_bytes></args>

</agent_response>`);
  assert.equal(parsed.done, false);
  assert.equal(parsed.toolCall.name, "fs.read");
  assert.equal(parsed.toolCall.args.path, "Sources/SweepKit/TreeWalker.swift");
  assert.equal(parsed.toolCall.args.offset, "0");
});

test("does not invent a tool call when more than the closing tag is missing", () => {
  assert.throws(
    () => parseAgentResponse(`
<agent_response>
  <done>false</done>
  <message>broken</message>
  <tool_call name="fs.read">
    <args><path>a.swift</path>
</agent_response>`),
    /Invalid XML/,
  );
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

test("truncation protocol errors carry split-into-small-edits guidance", () => {
  const truncated = serializeProtocolError(
    new Error("Response must contain one complete <agent_response> envelope."),
  );
  assert.match(truncated, /cut off|SMALL fs\.edit calls/);
  assert.match(truncated, /<\/protocol_error>$/);

  // Non-structural protocol errors (e.g. a semantic rule) carry no guidance.
  const other = serializeProtocolError(
    new Error("A completed response cannot also request a tool."),
  );
  assert.doesNotMatch(other, /SMALL fs\.edit calls/);
});

test("raw-code XML errors carry CDATA guidance", () => {
  const xml = serializeProtocolError(
    new Error("Invalid XML: Invalid space after '<'."),
  );
  assert.match(xml, /Wrap ALL code and file content in CDATA/);
  assert.match(xml, /SMALL fs\.edit calls/);
});
