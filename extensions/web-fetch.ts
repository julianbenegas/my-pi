import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const webFetchParameters = Type.Object({
  url: Type.String({ description: "URL to fetch." }),
});

type WebFetchParams = {
  url: string;
};

type WebFetchDetails = {
  url: string;
  status?: number;
  statusText?: string;
  ok?: boolean;
  headers?: Record<string, string>;
  lineCount?: number;
  preview?: string;
  code?: string;
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a URL as text/markdown and return the response body text.",
    promptSnippet: "Fetch a web URL as text/markdown and return the response body text.",
    promptGuidelines: [
      "Use web_fetch when the user asks to read or inspect a web page, markdown document, or text URL.",
      "web_fetch returns raw response text; summarize or extract relevant parts for the user when appropriate.",
    ],
    parameters: webFetchParameters,
    async execute(_toolCallId, params: WebFetchParams, signal): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: WebFetchDetails;
      isError?: boolean;
    }> {
      let url: URL;
      try {
        url = new URL(params.url);
      } catch {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Invalid URL: ${params.url}` }],
          details: { code: "invalid_url", url: params.url } satisfies WebFetchDetails,
        };
      }

      const response = await fetch(url, {
        headers: {
          Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1",
          "User-Agent": "pi-web-fetch/0.1 (+https://github.com/julianbenegas/my-pi)",
        },
        signal,
      });

      const text = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        content: [{ type: "text" as const, text }],
        details: {
          url: url.toString(),
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
          headers,
          lineCount: text.split(/\r?\n/).length,
          preview: previewLines(text),
        } satisfies WebFetchDetails,
        isError: !response.ok,
      };
    },

    renderCall(args, theme, _context) {
      const params = args as WebFetchParams;
      return new Text(theme.fg("muted", `Fetching ${params.url}`), 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as WebFetchDetails | undefined;
      const text = result.content.find(part => part.type === "text")?.text ?? "";
      const status = details?.status == null ? "" : ` (${details.status} ${details.statusText ?? ""})`;
      const preview = details?.preview ?? previewLines(text);

      return new Text(
        [theme.fg(details?.ok === false ? "error" : "success", `Fetched${status}`), preview].join("\n"),
        0,
        0,
      );
    },
  });
}

function previewLines(text: string) {
  const lines = text.split(/\r?\n/);
  if (lines.length <= 7) return lines.join("\n");

  const head = lines.slice(0, 3);
  const tail = lines.slice(-3);
  const omitted = lines.length - head.length - tail.length;

  return [...head, `... ${omitted} more lines ...`, ...tail].join("\n");
}
