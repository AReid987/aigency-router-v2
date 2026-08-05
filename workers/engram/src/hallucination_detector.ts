/**
 * hallucination_detector.ts — Embedding-based hallucination detector.
 *
 * Uses cosine similarity between output and reference text embeddings
 * to detect potential hallucinations. An injectable embed_fn allows
 * mocking in tests and wiring to production embedding models.
 *
 * Cosine similarity is computed in pure TypeScript — no numpy or
 * external vector math dependencies.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type EmbedFn = (text: string) => number[] | Promise<number[]>

export interface HallucinationResult {
  score: number
  isHallucination: boolean
}

// ── Cosine Similarity ──────────────────────────────────────────────────

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns 0 for zero-vector inputs (avoids division by zero).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: ${a.length} vs ${b.length}`,
    )
  }

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  if (normA === 0 || normB === 0) return 0
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

// ── HallucinationDetector ──────────────────────────────────────────────

export class HallucinationDetector {
  private readonly embedFn: EmbedFn
  private readonly threshold: number

  /**
   * @param embedFn - Function that converts text to an embedding vector.
   * @param threshold - Similarity threshold below which output is flagged
   *                    as hallucination (default: 0.6).
   */
  constructor(embedFn: EmbedFn, threshold: number = 0.6) {
    this.embedFn = embedFn
    this.threshold = threshold
  }

  /**
   * Evaluate whether the output is hallucinated relative to reference text.
   *
   * Computes embeddings for both output and reference, then compares
   * their cosine similarity against the configured threshold.
   *
   * @param output - The model-generated output to evaluate.
   * @param referenceText - The ground-truth reference text.
   * @returns {HallucinationResult} Evaluation result with score and verdict.
   */
  async evaluate(
    output: string,
    referenceText: string,
  ): Promise<HallucinationResult> {
    if (!output || !referenceText) {
      return { score: 0, isHallucination: true }
    }

    const [outputEmbedding, referenceEmbedding] = await Promise.all([
      this.embedFn(output),
      this.embedFn(referenceText),
    ])

    const score = cosineSimilarity(outputEmbedding, referenceEmbedding)
    const isHallucination = score < this.threshold

    return { score, isHallucination }
  }
}
