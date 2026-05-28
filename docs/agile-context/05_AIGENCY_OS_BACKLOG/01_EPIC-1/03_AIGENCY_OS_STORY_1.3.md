# Story 1.3: Port Providers to Vault Ecosystem

**Overview Description:** Extract the existing API connection logic from the `freellmapi` source and adapt it to dynamically pull credentials from the new SugarVault.

**Complexity Score:** 5 (Medium)

**Dependencies:** Story 1.2

**Developer Guidance:** Focus strictly on Groq, Cerebras, and Together AI for the MVP. They must implement a unified `ChatCompletionProvider` interface to ensure the OmniGateway can interact with them uniformly.

### Checkbox Tasklist:
* [ ] Create `src/providers/` directory.
* [ ] Port `groq.ts`, `cerebras.ts`, and `together.ts`.
* [ ] Refactor their constructors to accept a dynamic API key fetched from `VaultManager` just-in-time.

### Acceptance Criteria:
* Provider classes successfully execute a `fetch()` call to their respective upstream APIs using decrypted Vault keys.

### Resource URLs:
* Groq API: [https://console.groq.com/docs/api-reference](https://console.groq.com/docs/api-reference)
* Cerebras API: [https://inference-docs.cerebras.ai/](https://inference-docs.cerebras.ai/)
* Together AI API: [https://docs.together.ai/docs/inference-rest](https://docs.together.ai/docs/inference-rest)