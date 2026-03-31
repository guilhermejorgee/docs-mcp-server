import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { LibraryNotFoundInStoreError } from "../store/errors";

/**
 * Creates a success response object in the format expected by the MCP server.
 * @param text The text content of the response.
 * @returns The response object.
 */
export function createResponse(text: string): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    isError: false,
  };
}

/**
 * Creates an error response object in the format expected by the MCP server.
 * @param text The error message.
 * @returns The response object.
 */
export function createError(errorOrText: unknown): CallToolResult {
  let text: string;
  if (errorOrText instanceof LibraryNotFoundInStoreError) {
    const suggestions = errorOrText.similarLibraries;
    if (suggestions.length > 0) {
      const suggestionList = suggestions
        .map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ""}`)
        .join("\n");
      text = `${errorOrText.message}\n\nSuggestions:\n${suggestionList}`;
    } else {
      text = errorOrText.message;
    }
  } else {
    text = errorOrText instanceof Error ? errorOrText.message : String(errorOrText);
  }
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    isError: true,
  };
}
