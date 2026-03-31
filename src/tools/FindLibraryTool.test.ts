import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IDocumentManagement } from "../store/trpc/interfaces";
import { FindLibraryTool } from "./FindLibraryTool";

describe("FindLibraryTool", () => {
  let mockDocService: IDocumentManagement;
  let tool: FindLibraryTool;

  beforeEach(() => {
    mockDocService = {
      findLibraries: vi.fn(),
    } as unknown as IDocumentManagement;
    tool = new FindLibraryTool(mockDocService);
  });

  it("should return matching libraries from docService.findLibraries", async () => {
    const expected = [
      { name: "react", description: "A JavaScript library for building user interfaces" },
      { name: "react-dom", description: null },
    ];
    vi.mocked(mockDocService.findLibraries).mockResolvedValue(expected);

    const result = await tool.execute({ query: "react" });

    expect(mockDocService.findLibraries).toHaveBeenCalledWith("react", 5);
    expect(result.libraries).toEqual(expected);
  });

  it("should return empty array when no results match", async () => {
    vi.mocked(mockDocService.findLibraries).mockResolvedValue([]);

    const result = await tool.execute({ query: "nonexistent-library-xyz" });

    expect(result.libraries).toEqual([]);
  });

  it("should forward custom limit to docService.findLibraries", async () => {
    vi.mocked(mockDocService.findLibraries).mockResolvedValue([]);

    await tool.execute({ query: "vue", limit: 10 });

    expect(mockDocService.findLibraries).toHaveBeenCalledWith("vue", 10);
  });
});
