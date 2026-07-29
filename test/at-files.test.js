import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractAtMentions } from "../src/cli/at-files.js";

async function withProject(run) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-at-")));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("resolves a bare @path to an existing project file", async () => {
  await withProject(async (root) => {
    await fs.writeFile(path.join(root, "notes.txt"), "hi");
    const result = await extractAtMentions("summarize @notes.txt please", root);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, "notes.txt");
    assert.equal(result.files[0].path, path.join(root, "notes.txt"));
    assert.equal(result.missing.length, 0);
  });
});

test("supports quoted paths with spaces", async () => {
  await withProject(async (root) => {
    await fs.writeFile(path.join(root, "my file.pdf"), "x");
    const result = await extractAtMentions('read @"my file.pdf"', root);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, "my file.pdf");
  });
});

test("reports a missing file instead of attaching it", async () => {
  await withProject(async (root) => {
    const result = await extractAtMentions("look at @ghost.txt", root);
    assert.equal(result.files.length, 0);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].requested, "ghost.txt");
  });
});

test("accepts an absolute path outside the project (web upload, not a local read)", async () => {
  await withProject(async (root) => {
    // A file the user points at with an absolute path outside the project must
    // be attachable: this is a web upload to their own ChatGPT session.
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-out-")));
    try {
      const abs = path.join(outside, "photo.jpeg");
      await fs.writeFile(abs, "img");
      const result = await extractAtMentions(`analyze @${abs}`, root);
      assert.equal(result.files.length, 1);
      assert.equal(result.files[0].name, "photo.jpeg");
      assert.equal(result.files[0].path, abs);
      assert.equal(result.missing.length, 0);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

test("accepts a relative path that points outside the project root", async () => {
  await withProject(async (root) => {
    const inner = path.join(root, "sub");
    await fs.mkdir(inner);
    await fs.writeFile(path.join(root, "shared.txt"), "shared");
    // `..` is no longer a boundary violation for uploads.
    const result = await extractAtMentions("use @../shared.txt", inner);
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].name, "shared.txt");
  });
});

test("does not treat an email address as a mention", async () => {
  await withProject(async (root) => {
    const result = await extractAtMentions("mail me at foo@bar.com", root);
    assert.equal(result.mentions.length, 0);
    assert.equal(result.files.length, 0);
  });
});

test("rejects a directory (only files attach)", async () => {
  await withProject(async (root) => {
    await fs.mkdir(path.join(root, "src"));
    const result = await extractAtMentions("check @src", root);
    assert.equal(result.files.length, 0);
    assert.equal(result.missing[0].reason, "not-a-file");
  });
});

test("dedupes repeated mentions of the same file", async () => {
  await withProject(async (root) => {
    await fs.writeFile(path.join(root, "a.txt"), "a");
    const result = await extractAtMentions("@a.txt and again @a.txt", root);
    assert.equal(result.files.length, 1);
  });
});
