import path from "node:path";
import { z } from "zod";
import { resolveToolPath } from "../policy/path-guard.js";

const xmlStringArray = z.preprocess((value) => {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value.item != null) {
    return Array.isArray(value.item) ? value.item : [value.item];
  }
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Treat malformed JSON-looking input as one path; Zod will validate it.
    }
  }
  return [value];
}, z.array(z.string().min(1)));

export const imageGenerateInputSchema = z.object({
  prompt: z.string().min(1),
  output_path: z.string().min(1),
  provider: z.enum(["auto", "chatgpt", "gemini", "grok"]).default("auto"),
  aspect_ratio: z.enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"])
    .default("auto"),
  reference_images: xmlStringArray.default([]),
  timeout_ms: z.coerce.number().int().min(30_000).max(30 * 60_000)
    .default(10 * 60_000),
});

export function registerImageTools(registry, { imageService }) {
  if (!imageService) return registry;
  registry.register({
    name: "image.generate",
    description: [
      "Generate one raster image through a supported web provider and download it to the local project.",
      "The operation succeeds only after a verified PNG, JPEG, or WebP artifact is atomically saved.",
      "If the provider finishes with text instead of an image, its reply is returned as a failed image result; read that reply before deciding the next step.",
      "Use provider=auto to use this session's provider when image-capable, otherwise ChatGPT;",
      "or choose chatgpt, gemini, or grok explicitly.",
      "Prefer aspect_ratio=auto. Unsupported ratios fall back to auto instead of failing.",
    ].join(" "),
    inputDescription:
      "<args><prompt><![CDATA[...]]></prompt><output_path>images/result.png</output_path><provider>auto</provider><aspect_ratio>auto|1:1|3:2|2:3|4:3|3:4|16:9|9:16</aspect_ratio><reference_images><item>references/style.png</item></reference_images><timeout_ms>600000</timeout_ms></args>",
    risk: "write",
    managesTimeout: true,
    requiresVisibleBrowser: true,
    inputSchema: imageGenerateInputSchema,
    execute: async (args, context) => {
      const referenceImages = [];
      for (const rawPath of args.reference_images) {
        const info = await resolveToolPath(context.projectRoot, rawPath);
        if (!info.inside && !context.allowOutside) {
          throw new Error(`Path is outside project root: ${info.path}`);
        }
        referenceImages.push(info.path);
      }
      const artifact = await imageService.generate({
        prompt: args.prompt,
        outputPath: args.output_path,
        provider: args.provider,
        aspectRatio: args.aspect_ratio,
        referenceImages,
        timeoutMs: args.timeout_ms,
      }, context);
      if (artifact.type === "text") {
        return {
          ok: false,
          message: `Image provider returned text instead of an image:\n\n${artifact.text}`,
          data: { response: artifact },
          meta: { code: "IMAGE_TEXT_RESPONSE", completionUnknown: false },
        };
      }
      const relative = path.relative(context.projectRoot, artifact.localPath);
      const location = relative && !relative.startsWith("..")
        ? relative
        : artifact.localPath;
      let message = `Generated image at ${location}.`;
      if (artifact.provenance?.requestedAspectRatio) {
        message += ` Requested aspect_ratio ${artifact.provenance.requestedAspectRatio} is not supported by ${artifact.provenance.provider}; used ${artifact.provenance.aspectRatio}.`;
      }
      return {
        ok: true,
        message,
        data: { artifact },
      };
    },
  });
  return registry;
}
