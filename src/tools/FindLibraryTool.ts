import type { IDocumentManagement, LibrarySuggestion } from "../store/trpc/interfaces";

export interface FindLibraryInput {
  query: string;
  limit?: number;
}

export interface FindLibraryResult {
  libraries: LibrarySuggestion[];
}

/**
 * Tool for finding libraries in the store matching a search query.
 * Uses full-text search and trigram similarity for discovery.
 */
export class FindLibraryTool {
  private docService: IDocumentManagement;

  constructor(docService: IDocumentManagement) {
    this.docService = docService;
  }

  async execute(options: FindLibraryInput): Promise<FindLibraryResult> {
    const { query, limit = 5 } = options;
    const libraries = await this.docService.findLibraries(query, limit);
    return { libraries };
  }
}
