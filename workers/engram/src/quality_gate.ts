/**
 * quality_gate.ts — QualityGate DSL with 5+ gate types.
 *
 * Defines a predicate-based DSL for quality gates:
 * contains, equals, regex, length_range, similarity_threshold.
 *
 * Each gate is a QualityGateSpec that can be parsed from a plain dict
 * and evaluated against an output string with optional reference text.
 *
 * The similarity_threshold gate requires an injectable similarity_fn
 * (default uses a simple cosine similarity stub; in production wire it
 * to an embedding model).
 */

// ── Types ──────────────────────────────────────────────────────────────

export type GateType =
  | 'contains'
  | 'equals'
  | 'regex'
  | 'length_range'
  | 'similarity_threshold'

export interface QualityGateSpec {
  gate_type: GateType
  value: string | [number, number]
  required: boolean
}

export interface GateResult {
  passed: boolean
  reasons: string[]
}

export type SimilarityFn = (a: string, b: string) => number

// ── Cosine Similarity (default implementation) ─────────────────────────

/**
 * Simple character-n-gram based cosine similarity when no embedding model
 * is available. This is a reasonable default for testing — in production
 * you'd wire it to sentence-transformers or another embedding model.
 *
 * Uses character bigrams to compute a cosine similarity between two strings.
 * Score range: 0 (completely different) to 1 (identical).
 */
export function defaultSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1

  const bigrams = (s: string): Map<string, number> => {
    const map = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const bigram = s.slice(i, i + 2)
      map.set(bigram, (map.get(bigram) ?? 0) + 1)
    }
    return map
  }

  const mapA = bigrams(a.toLowerCase())
  const mapB = bigrams(b.toLowerCase())

  let dotProduct = 0
  let normA = 0
  let normB = 0

  // Compute dot product and normA
  for (const [key, countA] of mapA) {
    const countB = mapB.get(key) ?? 0
    dotProduct += countA * countB
    normA += countA * countA
  }

  // Compute normB
  for (const countB of mapB.values()) {
    normB += countB * countB
  }

  if (normA === 0 || normB === 0) return 0

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

// ── Injectable default similarity map ──────────────────────────────────

/**
 * Default similarity function map. Keys are gate types that need similarity.
 * Can be overridden in production to use sentence-transformers or OpenAI
 * embeddings.
 */
function getDefaultSimilarityFn(): SimilarityFn {
  return defaultSimilarity
}

// ── Parse ──────────────────────────────────────────────────────────────

const VALID_GATE_TYPES: GateType[] = [
  'contains',
  'equals',
  'regex',
  'length_range',
  'similarity_threshold',
]

export function parse(specDict: Record<string, unknown>): QualityGateSpec {
  if (!specDict || typeof specDict !== 'object') {
    throw new ValueError('QualityGateSpec must be a non-null object')
  }

  const gateType = specDict.gate_type as GateType
  if (!VALID_GATE_TYPES.includes(gateType)) {
    throw new ValueError(
      `Invalid gate_type: "${String(gateType)}". Expected one of: ${VALID_GATE_TYPES.join(', ')}`,
    )
  }

  const value = specDict.value
  const required = specDict.required !== false // default: true

  // ── Validate value per gate type ──

  if (gateType === 'length_range') {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new ValueError(
        'length_range gate requires value to be a [min, max] tuple',
      )
    }
    const [min, max] = value as [unknown, unknown]
    if (typeof min !== 'number' || typeof max !== 'number') {
      throw new ValueError(
        'length_range gate requires value[0] and value[1] to be numbers',
      )
    }
    if (min < 0 || max < 0) {
      throw new ValueError(
        'length_range gate requires non-negative min and max values',
      )
    }
    if (min > max) {
      throw new ValueError(
        'length_range gate requires min <= max',
      )
    }
    return { gate_type: gateType, value: [min, max], required }
  }

  if (gateType === 'similarity_threshold') {
    if (typeof value !== 'number') {
      throw new ValueError(
        'similarity_threshold gate requires value to be a number (0-1)',
      )
    }
    if (value < 0 || value > 1) {
      throw new ValueError(
        'similarity_threshold gate requires value in range [0, 1]',
      )
    }
    return { gate_type: gateType, value: value as number, required }
  }

  // contains, equals, regex
  if (typeof value !== 'string') {
    throw new ValueError(
      `${gateType} gate requires value to be a string`,
    )
  }

  if (gateType === 'regex') {
    try {
      new RegExp(value as string)
    } catch {
      throw new ValueError(
        `regex gate requires value to be a valid regex pattern: "${String(value)}"`,
      )
    }
  }

  return { gate_type: gateType, value: value as string, required }
}

// ── Evaluate ───────────────────────────────────────────────────────────

export function evaluate(
  spec: QualityGateSpec,
  output: string,
  referenceText?: string,
  similarityFn?: SimilarityFn,
): GateResult {
  const reasons: string[] = []
  let passed = false

  switch (spec.gate_type) {
    case 'contains': {
      const needle = spec.value as string
      passed = output.includes(needle)
      if (!passed) {
        reasons.push(
          `Output does not contain expected text: "${needle}"`,
        )
      } else {
        reasons.push(`Output contains expected text: "${needle}"`)
      }
      break
    }

    case 'equals': {
      const expected = spec.value as string
      passed = output.trim() === expected
      if (!passed) {
        reasons.push(
          `Output "${output.trim()}" does not equal expected "${expected}"`,
        )
      } else {
        reasons.push(`Output equals expected "${expected}"`)
      }
      break
    }

    case 'regex': {
      const pattern = new RegExp(spec.value as string)
      passed = pattern.test(output)
      if (!passed) {
        reasons.push(
          `Output does not match regex pattern: "${spec.value}"`,
        )
      } else {
        reasons.push(`Output matches regex pattern: "${spec.value}"`)
      }
      break
    }

    case 'length_range': {
      const [min, max] = spec.value as [number, number]
      const length = output.length
      passed = length >= min && length <= max
      if (!passed) {
        reasons.push(
          `Output length ${length} is outside range [${min}, ${max}]`,
        )
      } else {
        reasons.push(`Output length ${length} is within range [${min}, ${max}]`)
      }
      break
    }

    case 'similarity_threshold': {
      const threshold = spec.value as number
      if (!referenceText) {
        passed = false
        reasons.push(
          'similarity_threshold gate requires reference_text',
        )
        break
      }
      const fn = similarityFn ?? getDefaultSimilarityFn()
      const score = fn(output, referenceText)
      passed = score >= threshold
      if (!passed) {
        reasons.push(
          `Similarity score ${score.toFixed(4)} is below threshold ${threshold}`,
        )
      } else {
        reasons.push(
          `Similarity score ${score.toFixed(4)} meets threshold ${threshold}`,
        )
      }
      break
    }

    default: {
      const exhaustive: never = spec.gate_type
      throw new Error(`Unknown gate_type: ${exhaustive}`)
    }
  }

  return { passed, reasons }
}

// ── Value Error ─────────────────────────────────────────────────────────

export class ValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValueError'
  }
}
