/**
 * Pluggable Selector Interface (R012)
 *
 * Classifies incoming model requests as 'simple' or 'complex' to enable
 * intelligent routing. The Selector interface is designed to be swapped out
 * when the M002 LLM router is integrated — HeuristicSelector is the default.
 */

/** A model routing request containing conversation context and constraints. */
export interface ModelRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  enforce_json?: boolean
  max_tokens?: number
}

/** Classification result: 'simple' requests are cheap/fast, 'complex' need more resources. */
export type Classification = 'simple' | 'complex'

/** Pluggable classifier interface — implement this to swap routing logic. */
export interface Selector {
  classify(request: ModelRequest): Classification
}

/** Thresholds for the heuristic selector. */
const MAX_SIMPLE_MESSAGES = 3
const MAX_SIMPLE_TOKENS = 4096

/**
 * Default heuristic selector.
 *
 * Simple: ≤3 messages, no JSON enforcement, max_tokens ≤ 4096 (or unset).
 * Complex: everything else.
 */
export class HeuristicSelector implements Selector {
  classify(request: ModelRequest): Classification {
    const messageCount = request.messages?.length ?? 0
    const enforceJson = request.enforce_json === true
    const highTokens = (request.max_tokens ?? 0) > MAX_SIMPLE_TOKENS

    if (messageCount > MAX_SIMPLE_MESSAGES) return 'complex'
    if (enforceJson) return 'complex'
    if (highTokens) return 'complex'

    return 'simple'
  }
}

/** Factory — returns the default HeuristicSelector. Swap for a custom Selector at runtime. */
export function createSelector(): Selector {
  return new HeuristicSelector()
}
