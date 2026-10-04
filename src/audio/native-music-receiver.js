import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import { inspectMusicBuffer } from "./music-artifact.js";

const execFileAsync = promisify(execFile);
export const MUSIC_SYSTEM_REMINDER = "Use Gemini's native Music tool to create the requested playable music. "
  + "Return the generated track directly, with an optional short description. Do not use XML, code, or local tools. "
  + "If music cannot be generated, explain the limitation plainly. WTAgent downloads the generated file automatically.";

export function validateGenerationType(type, provider) {
  const value = type ?? "agent";
  if (!["agent", "music"].includes(value)) throw new Error(`Unknown --type ${value}. Use agent or music.`);
  if (value === "music" && provider !== "gemini") throw new Error("--type music requires --model gemini.");
  return value;
}

export class NativeMusicReceiver {
  constructor({ adapter, extractAudio = extractAudioTrack }) {
    this.adapter = adapter;
    this.extractAudio = extractAudio;
  }

  async prepare() {
    await this.adapter.prepareMusicGeneration();
  }

  async read(message) {
    return await message.locator("video, audio").evaluateAll((elements) => ({
      pending: elements.some((element) => !element.currentSrc && !element.src),
      music: elements.filter((element) => element.isConnected && (element.currentSrc || element.src))
        .map((element) => ({ source: element.currentSrc || element.src })),
    }));
  }

  async save(tracks, { projectRoot, handoffId, assistantMessageId }) {
    const store = new ArtifactStore({ projectRoot });
    const directory = path.join("artifacts", "music", createHash("sha256").update(handoffId).digest("hex").slice(0, 24));
    const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtagent-music-"));
    const artifacts = [];
    try {
      for (const [index, track] of tracks.entries()) {
        const url = new URL(track.source);
        if (url.protocol !== "https:" || !(url.hostname === "contribution.usercontent.google.com"
            || url.hostname.endsWith(".googleusercontent.com"))) {
          throw new Error("The music source is not a supported Gemini media URL.");
        }
        const response = await this.adapter.page.request.get(track.source, { timeout: 60_000 });
        if (!response.ok()) throw new Error(`Music download failed with HTTP ${response.status()}.`);
        const body = await response.body();
        const inspected = inspectMusicBuffer(body);
        const source = path.join(temporaryDir, `track-${index + 1}${inspected.extension}`);
        await fs.writeFile(source, body);
        const provenance = { provider: "gemini", assistantMessageId, source: track.source };
        const original = await store.saveMusic(source, path.join(directory, path.basename(source)), provenance);
        artifacts.push(original);
        if (inspected.hasVideo) {
          const audioPath = path.join(temporaryDir, `track-${index + 1}.m4a`);
          const extraction = await this.extractAudio(source, audioPath);
          if (extraction.ok) {
            artifacts.push(await store.saveMusic(audioPath, path.join(directory, path.basename(audioPath)), {
              ...provenance, extractedFrom: original.localPath, lossless: true,
            }));
          } else {
            original.audioExtractionNote = extraction.message;
          }
        }
      }
      return artifacts;
    } finally {
      await fs.rm(temporaryDir, { recursive: true, force: true });
    }
  }
}

async function extractAudioTrack(source, output) {
  try {
    await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-n", "-i", source, "-map", "0:a:0", "-vn", "-c:a", "copy", output], {
      timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.code === "ENOENT"
      ? "FFmpeg is not installed; the original MP4 with its audio track was saved."
      : "Audio extraction failed; the original MP4 with its audio track was saved." };
  }
}
