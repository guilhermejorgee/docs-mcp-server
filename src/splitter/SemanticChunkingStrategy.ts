import type { Embeddings } from "@langchain/core/embeddings";
import type { Chunk, DocumentSplitter } from "./types";

/**
 * Splits document content into semantically coherent chunks by detecting
 * topic boundaries via cosine-similarity drops between adjacent sentence embeddings.
 */
export class SemanticChunkingStrategy implements DocumentSplitter {
  constructor(
    private readonly embeddings: Embeddings,
    private readonly threshold?: number,
  ) {}

  async splitText(content: string, _contentType?: string): Promise<Chunk[]> {
    if (!content || content.trim().length === 0) {
      return [];
    }

    const sentences = this.splitIntoSentences(content);

    if (sentences.length <= 1) {
      return [
        {
          content: content.trim(),
          types: ["text"],
          section: { level: 0, path: [] },
        },
      ];
    }

    const vectors = await this.embeddings.embedDocuments(sentences);

    const similarities: number[] = [];
    for (let i = 0; i < vectors.length - 1; i++) {
      similarities.push(this.cosineSimilarity(vectors[i], vectors[i + 1]));
    }

    const cutThreshold = this.threshold ?? this.computeThreshold(similarities);
    const boundaries = this.detectBoundaries(similarities, cutThreshold);

    const chunks: Chunk[] = [];
    let current: string[] = [];

    for (let i = 0; i < sentences.length; i++) {
      current.push(sentences[i]);
      if (boundaries.has(i) || i === sentences.length - 1) {
        const chunkContent = current.join(" ").trim();
        if (chunkContent.length > 0) {
          chunks.push({
            content: chunkContent,
            types: ["text"],
            section: { level: 0, path: [] },
          });
        }
        current = [];
      }
    }

    return chunks;
  }

  private splitIntoSentences(content: string): string[] {
    return content
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Computes the adaptive threshold as the 25th percentile of similarity values.
   * Sentences with similarity below this value are treated as topic boundaries.
   */
  private computeThreshold(similarities: number[]): number {
    if (similarities.length === 0) return 0.5;
    const sorted = [...similarities].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.25);
    return sorted[idx];
  }

  /**
   * Returns the set of sentence indices after which a boundary occurs
   * (i.e., where similarity[i] < threshold, meaning a cut between sentence i and i+1).
   */
  private detectBoundaries(similarities: number[], threshold: number): Set<number> {
    const boundaries = new Set<number>();
    for (let i = 0; i < similarities.length; i++) {
      if (similarities[i] < threshold) {
        boundaries.add(i);
      }
    }
    return boundaries;
  }
}
