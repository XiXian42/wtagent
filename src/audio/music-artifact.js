import { createHash } from "node:crypto";

function boxes(buffer, start = 0, end = buffer.length) {
  const result = [];
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) throw new Error("Truncated music container.");
    let size = buffer.readUInt32BE(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) throw new Error("Truncated music container.");
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) size = end - offset;
    if (!Number.isSafeInteger(size) || size < header || offset + size > end) {
      throw new Error("Invalid music container size.");
    }
    result.push({ type: buffer.toString("ascii", offset + 4, offset + 8), start: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

// Gemini's Music player currently serves an MP4 containing cover video and AAC.
// Check the actual audio track, not the URL suffix or the provider's caption.
export function inspectMusicBuffer(buffer) {
  const top = boxes(buffer);
  const moov = top.find((box) => box.type === "moov");
  if (!top.some((box) => box.type === "ftyp") || !moov
      || !top.some((box) => box.type === "mdat" && box.end > box.start)) {
    throw new Error("The downloaded music is not a complete MP4/M4A file.");
  }
  const tracks = boxes(buffer, moov.start, moov.end).filter((box) => box.type === "trak");
  const handlers = [];
  let durationSeconds = null;
  for (const track of tracks) {
    const mdia = boxes(buffer, track.start, track.end).find((box) => box.type === "mdia");
    if (!mdia) continue;
    const children = boxes(buffer, mdia.start, mdia.end);
    const hdlr = children.find((box) => box.type === "hdlr");
    if (!hdlr || hdlr.start + 12 > hdlr.end) continue;
    const handler = buffer.toString("ascii", hdlr.start + 8, hdlr.start + 12);
    handlers.push(handler);
    if (handler !== "soun") continue;
    const mdhd = children.find((box) => box.type === "mdhd");
    if (!mdhd) continue;
    const version = buffer[mdhd.start];
    const timeOffset = mdhd.start + (version === 1 ? 20 : 12);
    if (![0, 1].includes(version) || timeOffset + (version === 1 ? 12 : 8) > mdhd.end) continue;
    const scale = buffer.readUInt32BE(timeOffset);
    const duration = version === 1
      ? Number(buffer.readBigUInt64BE(timeOffset + 4)) : buffer.readUInt32BE(timeOffset + 4);
    if (scale > 0 && duration > 0) durationSeconds = duration / scale;
  }
  if (!handlers.includes("soun") || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("The downloaded music file has no valid audio track.");
  }
  const hasVideo = handlers.includes("vide");
  return {
    mimeType: hasVideo ? "video/mp4" : "audio/mp4",
    extension: hasVideo ? ".mp4" : ".m4a",
    durationSeconds,
    hasVideo,
    size: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}
