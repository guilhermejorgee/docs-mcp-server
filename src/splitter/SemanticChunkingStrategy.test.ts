import { describe, expect, it, vi } from "vitest";
import { SemanticChunkingStrategy } from "./SemanticChunkingStrategy";

function makeMockEmbeddings(
  vectorMap: Record<string, number[]>,
  defaultVector?: number[],
) {
  return {
    embedDocuments: vi.fn(async (texts: string[]) =>
      texts.map((t) => vectorMap[t] ?? defaultVector ?? [0, 0, 0]),
    ),
    embedQuery: vi.fn(
      async (text: string) => vectorMap[text] ?? defaultVector ?? [0, 0, 0],
    ),
  };
}

describe("SemanticChunkingStrategy", () => {
  it("returns empty array for empty input", async () => {
    const embeddings = makeMockEmbeddings({});
    const strategy = new SemanticChunkingStrategy(embeddings as never);
    const result = await strategy.splitText("");
    expect(result).toEqual([]);
  });

  it("returns single chunk for whitespace-only input", async () => {
    const embeddings = makeMockEmbeddings({});
    const strategy = new SemanticChunkingStrategy(embeddings as never);
    const result = await strategy.splitText("   ");
    expect(result).toEqual([]);
  });

  it("returns single chunk for a single sentence", async () => {
    const embeddings = makeMockEmbeddings({
      "Hello world.": [1, 0, 0],
    });
    const strategy = new SemanticChunkingStrategy(embeddings as never);
    const result = await strategy.splitText("Hello world.");
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Hello world.");
    expect(result[0].types).toEqual(["text"]);
    expect(result[0].section).toEqual({ level: 0, path: [] });
  });

  it("keeps all sentences in one chunk when similarity is high", async () => {
    // All sentences are semantically identical (same vector)
    const vec = [1, 0, 0];
    const embeddings = {
      embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => vec)),
      embedQuery: vi.fn(async () => vec),
    };
    const strategy = new SemanticChunkingStrategy(embeddings as never);
    const content = "First sentence. Second sentence. Third sentence.";
    const result = await strategy.splitText(content);
    // High similarity everywhere → no boundaries → one chunk
    expect(result).toHaveLength(1);
  });

  it("splits into multiple chunks when similarity drops strongly", async () => {
    // Topic A: 3 sentences cluster together, Topic B: 2 sentences are orthogonal.
    // This gives 4 similarities: [1.0, 1.0, 0.0, 1.0].
    // sorted = [0.0, 1.0, 1.0, 1.0]; 25th percentile idx=1 → threshold=1.0.
    // Only the 0.0 similarity triggers a boundary.
    const topicA = [1, 0, 0];
    const topicB = [0, 1, 0];
    const sentences = [
      "Cats are fluffy animals.",
      "Kittens love to play.",
      "Cats and kittens are related creatures.",
      "Quantum mechanics describes subatomic particles.",
      "Wave functions collapse upon observation.",
    ];
    const vectors: Record<string, number[]> = {
      [sentences[0]]: topicA,
      [sentences[1]]: topicA,
      [sentences[2]]: topicA,
      [sentences[3]]: topicB,
      [sentences[4]]: topicB,
    };
    const embeddings = makeMockEmbeddings(vectors, topicA);
    const strategy = new SemanticChunkingStrategy(embeddings as never);
    const result = await strategy.splitText(sentences.join(" "));
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("respects explicit threshold parameter", async () => {
    const topicA = [1, 0, 0];
    const topicB = [0, 1, 0];
    const sentences = ["Sentence one.", "Sentence two.", "Sentence three."];
    const vectors: Record<string, number[]> = {
      [sentences[0]]: topicA,
      [sentences[1]]: topicA,
      [sentences[2]]: topicB,
    };
    const embeddings = makeMockEmbeddings(vectors, topicA);

    // With very high threshold (1.0) every pair is a boundary
    const strategy = new SemanticChunkingStrategy(embeddings as never, 1.0);
    const resultHigh = await strategy.splitText(sentences.join(" "));
    // Low threshold (0.0) → no boundaries
    const strategy2 = new SemanticChunkingStrategy(embeddings as never, 0.0);
    const resultLow = await strategy2.splitText(sentences.join(" "));

    expect(resultHigh.length).toBeGreaterThan(resultLow.length);
  });

  it("calls embedDocuments once per splitText call", async () => {
    const vec = [1, 0, 0];
    const embeddings = {
      embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => vec)),
      embedQuery: vi.fn(async () => vec),
    };
    const strategy = new SemanticChunkingStrategy(embeddings as never);
    await strategy.splitText("First sentence. Second sentence.");
    expect(embeddings.embedDocuments).toHaveBeenCalledTimes(1);
  });

  it("produces chunks with correct types and section fields", async () => {
    const vec = [1, 0, 0];
    const embeddings = {
      embedDocuments: vi.fn(async (texts: string[]) => texts.map(() => vec)),
      embedQuery: vi.fn(async () => vec),
    };
    const strategy = new SemanticChunkingStrategy(embeddings as never);
    const [chunk] = await strategy.splitText("A single sentence.");
    expect(chunk.types).toEqual(["text"]);
    expect(chunk.section.level).toBe(0);
    expect(chunk.section.path).toEqual([]);
  });
});
