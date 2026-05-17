import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateImage, createGateway } from "ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MODEL = "openai/gpt-image-2";
const DEFAULT_OUTPUT_DIR = ".pi/generated-images";

const generateImageParameters = Type.Object({
  prompt: Type.String({ description: "Prompt describing the image to generate." }),
  model: Type.Optional(
    Type.String({
      description: `Vercel AI Gateway image model ID. Defaults to ${DEFAULT_MODEL}. Do not override unless the user explicitly asks for a different model.`,
    }),
  ),
  n: Type.Optional(
    Type.Number({
      description: "Number of images to generate. Defaults to 1.",
      minimum: 1,
      maximum: 4,
    }),
  ),
  size: Type.Optional(
    Type.String({
      description: "Image size in {width}x{height} format, for example 1024x1024. Do not combine with aspectRatio.",
    }),
  ),
  aspectRatio: Type.Optional(
    Type.String({
      description: "Image aspect ratio in {width}:{height} format, for example 16:9. Do not combine with size.",
    }),
  ),
  seed: Type.Optional(Type.Number({ description: "Optional seed for reproducible generation when supported." })),
  outputDir: Type.Optional(
    Type.String({
      description: `Directory to write generated image files into. Relative paths are resolved from Pi's current working directory. Defaults to ${DEFAULT_OUTPUT_DIR}.`,
    }),
  ),
  fileNamePrefix: Type.Optional(
    Type.String({
      description: "Optional filename prefix. Unsafe filename characters will be replaced with dashes.",
    }),
  ),
});

type GenerateImageParams = {
  prompt: string;
  model?: string;
  n?: number;
  size?: string;
  aspectRatio?: string;
  seed?: number;
  outputDir?: string;
  fileNamePrefix?: string;
};

type GeneratedImageFile = {
  path: string;
  mediaType: string | undefined;
  bytes: number;
};

type GenerateImageDetails = {
  model: string;
  prompt: string;
  parameters: {
    n: number;
    size?: string;
    aspectRatio?: string;
    seed?: number;
    outputDir: string;
  };
  files: GeneratedImageFile[];
  warnings?: unknown;
  usage?: unknown;
  responses?: unknown;
  providerMetadata?: unknown;
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "generate_image",
    label: "Generate Image",
    description: "Generate images with Vercel AI Gateway image models and write them to disk.",
    promptSnippet: "Generate images using Vercel AI Gateway image models and save the files locally.",
    promptGuidelines: [
      "Use generate_image when the user asks to generate or create an AI image file.",
      `Use generate_image's default model (${DEFAULT_MODEL}) unless the user explicitly requests a different image model.`,
      "When using generate_image, return the generated file paths to the user.",
    ],
    parameters: generateImageParameters,
    async execute(_toolCallId, params: GenerateImageParams, signal, onUpdate, ctx) {
      if (params.size && params.aspectRatio) {
        return {
          isError: true,
          content: [{ type: "text", text: "Pass either size or aspectRatio, not both." }],
          details: { code: "size_and_aspect_ratio" },
        };
      }

      const apiKey =
        process.env.AI_GATEWAY_API_KEY_CODING_AGENT ??
        process.env.AI_GATEWAY_API_KEY ??
        process.env.VERCEL_AI_GATEWAY_API_KEY;
      if (!apiKey) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Missing AI Gateway auth. Set AI_GATEWAY_API_KEY_CODING_AGENT, AI_GATEWAY_API_KEY, or VERCEL_AI_GATEWAY_API_KEY, then reload/restart Pi.",
            },
          ],
          details: { code: "missing_ai_gateway_api_key" },
        };
      }

      const model = params.model ?? DEFAULT_MODEL;
      const outputDir = path.resolve(ctx.cwd, params.outputDir ?? DEFAULT_OUTPUT_DIR);
      await mkdir(outputDir, { recursive: true });

      onUpdate?.({
        content: [
          {
            type: "text",
            text: formatGenerationSummary({ ...params, model, outputDir, n: params.n ?? 1 }),
          },
        ],
        details: {},
      });

      const gateway = createGateway({ apiKey });
      const imageOptions = {
        model: gateway.imageModel(model),
        prompt: params.prompt,
        n: params.n ?? 1,
        ...(params.size ? { size: params.size as `${number}x${number}` } : {}),
        ...(params.aspectRatio ? { aspectRatio: params.aspectRatio as `${number}:${number}` } : {}),
        ...(params.seed == null ? {} : { seed: params.seed }),
        abortSignal: signal,
      };
      const result = await generateImage(imageOptions);

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const prefix = sanitizeFilePart(params.fileNamePrefix ?? summarizePrompt(params.prompt));
      const files = await Promise.all(
        result.images.map(async (image, index) => {
          const extension = extensionForMediaType(image.mediaType);
          const filePath = path.join(outputDir, `${timestamp}-${prefix}-${index + 1}.${extension}`);
          await writeFile(filePath, Buffer.from(image.uint8Array));
          return {
            path: filePath,
            mediaType: image.mediaType,
            bytes: image.uint8Array.byteLength,
          };
        }),
      );

      return {
        content: [
          {
            type: "text",
            text: [`Generated ${files.length} image(s):`, ...files.map(file => `- ${file.path}`)].join("\n"),
          },
        ],
        details: {
          model,
          prompt: params.prompt,
          parameters: {
            n: params.n ?? 1,
            ...(params.size ? { size: params.size } : {}),
            ...(params.aspectRatio ? { aspectRatio: params.aspectRatio } : {}),
            ...(params.seed == null ? {} : { seed: params.seed }),
            outputDir,
          },
          files,
          warnings: result.warnings,
          usage: result.usage,
          responses: result.responses,
          providerMetadata: result.providerMetadata,
        } satisfies GenerateImageDetails,
      };
    },

    renderCall(args, theme, _context) {
      const params = args as GenerateImageParams;
      return new Text(
        formatGenerationSummary({ ...params, model: params.model ?? DEFAULT_MODEL, n: params.n ?? 1 }),
        0,
        0,
        (text: string) => theme.fg("muted", text),
      );
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as GenerateImageDetails | undefined;
      const fallbackText = result.content.find(part => part.type === "text")?.text ?? "";

      if (!details) {
        return new Text(fallbackText, 0, 0);
      }

      const lines = [
        theme.fg("success", `Generated ${details.files.length} image(s)`),
        `model: ${details.model}`,
        `prompt: ${details.prompt}`,
        `n: ${details.parameters.n}`,
        ...(details.parameters.size ? [`size: ${details.parameters.size}`] : []),
        ...(details.parameters.aspectRatio ? [`aspectRatio: ${details.parameters.aspectRatio}`] : []),
        ...(details.parameters.seed == null ? [] : [`seed: ${details.parameters.seed}`]),
        `outputDir: ${details.parameters.outputDir}`,
        "files:",
        ...details.files.map(file => `- ${file.path}`),
      ];

      return new Text(lines.join("\n"), 0, 0);
    },
  });
}

function formatGenerationSummary(params: GenerateImageParams & { model: string; n: number; outputDir?: string }) {
  return [
    `Generating ${params.n} image(s)`,
    `model: ${params.model}`,
    `prompt: ${params.prompt}`,
    ...(params.size ? [`size: ${params.size}`] : []),
    ...(params.aspectRatio ? [`aspectRatio: ${params.aspectRatio}`] : []),
    ...(params.seed == null ? [] : [`seed: ${params.seed}`]),
    ...(params.outputDir ? [`outputDir: ${params.outputDir}`] : []),
  ].join("\n");
}

function summarizePrompt(prompt: string) {
  return prompt.trim().split(/\s+/).slice(0, 8).join("-") || "image";
}

function sanitizeFilePart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "image";
}

function extensionForMediaType(mediaType: string | undefined) {
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/png":
    default:
      return "png";
  }
}

// Makes this file path easy to identify in stack traces/logs when loaded by jiti.
export const __filename = fileURLToPath(import.meta.url);
