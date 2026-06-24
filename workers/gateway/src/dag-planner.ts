/**
 * DAG Planner — decomposes a request into ordered sub-tasks.
 *
 * TaskDAG shape: { nodes: [...], root: string }
 * Each node: { id, function_id, payload, depends_on: string[] }
 *
 * The gateway invokes planner.plan() before brain classification. If the
 * planner returns a 1-node DAG, gateway falls back to the existing
 * single-step path (no DAG machinery overhead for simple requests).
 */

export interface TaskNode {
  id: string
  function_id: string
  payload: Record<string, unknown>
  depends_on: string[]
}

export interface TaskDAG {
  nodes: TaskNode[]
  root: string
}

export interface PlannerInput {
  model: string
  messages: Array<{ role: string; content: string }>
  stream?: boolean
  max_tokens?: number
  temperature?: number
}

export interface DAGPlanner {
  plan(input: PlannerInput): TaskDAG
}

/**
 * SimpleDAGPlanner — heuristic decomposition.
 *
 * Detects multi-intent via " and " keyword or 2+ user messages.
 * Returns a 1-node DAG for simple requests.
 */
export class SimpleDAGPlanner implements DAGPlanner {
  plan(input: PlannerInput): TaskDAG {
    const lastUser = [...input.messages].reverse().find((m) => m.role === "user");
    const lastContent = lastUser?.content ?? "";
    // Heuristic 1: 2+ user messages → multi-intent
    const userMsgCount = input.messages.filter((m) => m.role === "user").length;
    // Heuristic 2: explicit " and " or " then " keyword in single message
    const hasConjunction = /\b(and|then|also|plus)\b/i.test(lastContent);

    if (userMsgCount < 2 && !hasConjunction) {
      // Single intent — return 1-node DAG (gateway falls back to single-step)
      return {
        nodes: [
          {
            id: "n0",
            function_id: "gateway::chat_completions",
            payload: { ...input },
            depends_on: [],
          },
        ],
        root: "n0",
      };
    }

    // Multi-intent: 2+ user messages use each as separate intent; otherwise split on conjunction
    let intents: string[];
    if (userMsgCount >= 2) {
      intents = input.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content.trim())
        .filter((s) => s.length > 0);
    } else {
      intents = lastContent
        .split(/\b(?:and|then)\b/i)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    if (intents.length <= 1) {
      // Conjunction detected but couldn't split cleanly — single intent
      return {
        nodes: [
          {
            id: "n0",
            function_id: "gateway::chat_completions",
            payload: { ...input },
            depends_on: [],
          },
        ],
        root: "n0",
      };
    }

    // Build a DAG: first node runs first, then parallel children
    const nodes: TaskNode[] = [];
    intents.forEach((intent, i) => {
      nodes.push({
        id: `n${i}`,
        function_id: "gateway::chat_completions",
        payload: {
          ...input,
          messages: [{ role: "user", content: intent }],
        },
        depends_on: i === 0 ? [] : ["n0"],
      });
    });
    return { nodes, root: "n0" };
  }
}

/** Detect cycles in a DAG. Returns true if cycle exists. */
export function hasCycle(dag: TaskDAG): boolean {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const adj = new Map<string, string[]>();
  for (const node of dag.nodes) {
    adj.set(node.id, node.depends_on);
  }
  function dfs(id: string): boolean {
    if (stack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    stack.add(id);
    for (const dep of adj.get(id) ?? []) {
      if (dfs(dep)) return true;
    }
    stack.delete(id);
    return false;
  }
  for (const node of dag.nodes) {
    if (dfs(node.id)) return true;
  }
  return false;
}

/** Topological order of DAG nodes. Throws if cycle detected. */
export function topologicalOrder(dag: TaskDAG): string[] {
  if (hasCycle(dag)) {
    throw new Error("DAG contains a cycle");
  }
  const order: string[] = [];
  const visited = new Set<string>();
  const adj = new Map<string, string[]>();
  for (const node of dag.nodes) {
    adj.set(node.id, node.depends_on);
  }
  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dep of adj.get(id) ?? []) {
      visit(dep);
    }
    order.push(id);
  }
  for (const node of dag.nodes) {
    visit(node.id);
  }
  return order;
}
