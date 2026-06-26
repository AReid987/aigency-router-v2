/**
 * test-sdk-examples-validation.ts — Config validation + smoke tests for SDK examples.
 *
 * Verifies:
 *   1. Claude Code config.example.json is valid JSON with required fields
 *   2. aider config.example.yaml exists and references required fields
 *   3. Example READMEs document the correct env vars
 *   4. TS SDK exports AigencyClient (smoke test)
 *   5. Python SDK references AigencyClient (smoke test)
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Paths (relative to tests/integration/)
// ---------------------------------------------------------------------------
const PROJECT_ROOT = resolve(import.meta.dirname, '../..')

const CLAUDE_CODE_CONFIG = `${PROJECT_ROOT}/workers/agents/sdk/ts/examples/claude-code/config.example.json`
const CLAUDE_CODE_README  = `${PROJECT_ROOT}/workers/agents/sdk/ts/examples/claude-code/README.md`
const AIDER_CONFIG        = `${PROJECT_ROOT}/workers/agents/sdk/python/examples/aider/config.example.yaml`
const AIDER_README        = `${PROJECT_ROOT}/workers/agents/sdk/python/examples/aider/README.md`
const TS_SDK_INDEX        = `${PROJECT_ROOT}/workers/agents/sdk/ts/src/index.ts`
const PY_SDK_INIT         = `${PROJECT_ROOT}/workers/agents/sdk/python/aigency_sdk/__init__.py`

// ---------------------------------------------------------------------------
// 1. Claude Code config — JSON validation
// ---------------------------------------------------------------------------
describe('Claude Code example config', () => {
  it('config.example.json exists and is valid JSON', async () => {
    const raw = await readFile(CLAUDE_CODE_CONFIG, 'utf-8')
    const parsed = JSON.parse(raw)

    assert.ok(parsed.env, 'top-level "env" key must exist')
    assert.equal(typeof parsed.env.AIGENCY_BASE_URL, 'string', 'env.AIGENCY_BASE_URL must be a string')
    assert.equal(typeof parsed.env.AIGENCY_API_KEY, 'string', 'env.AIGENCY_API_KEY must be a string')

    assert.ok(parsed.claude_code_config, 'top-level "claude_code_config" key must exist')
    assert.equal(typeof parsed.claude_code_config.model, 'string', 'claude_code_config.model must be a string')
    assert.equal(typeof parsed.claude_code_config.api_base_url, 'string', 'claude_code_config.api_base_url must be a string')
    assert.equal(typeof parsed.claude_code_config.api_key, 'string', 'claude_code_config.api_key must be a string')

    // Verify env var references in config values
    assert.ok(
      parsed.claude_code_config.api_base_url.includes('AIGENCY_BASE_URL'),
      'api_base_url must reference AIGENCY_BASE_URL env var',
    )
    assert.ok(
      parsed.claude_code_config.api_key.includes('AIGENCY_API_KEY'),
      'api_key must reference AIGENCY_API_KEY env var',
    )
  })
})

// ---------------------------------------------------------------------------
// 2. aider config — file existence + raw content check (no YAML parser)
// ---------------------------------------------------------------------------
describe('aider example config', () => {
  it('config.example.yaml exists and references required fields', async () => {
    const st = await stat(AIDER_CONFIG)
    assert.ok(st.isFile(), 'config.example.yaml must be a file')
    assert.ok(st.size > 0, 'config.example.yaml must not be empty')

    const raw = await readFile(AIDER_CONFIG, 'utf-8')

    // Verify env var references are documented in the YAML comments
    assert.ok(
      raw.includes('AIGENCY_BASE_URL'),
      'config.example.yaml must mention AIGENCY_BASE_URL',
    )
    assert.ok(
      raw.includes('AIGENCY_API_KEY'),
      'config.example.yaml must mention AIGENCY_API_KEY',
    )
    assert.ok(
      raw.includes('openai-api-base'),
      'config.example.yaml must mention openai-api-base',
    )
    assert.ok(
      raw.includes('openai-api-key'),
      'config.example.yaml must mention openai-api-key',
    )
  })
})

// ---------------------------------------------------------------------------
// 3. READMEs — env var documentation
// ---------------------------------------------------------------------------
describe('Example READMEs document correct env vars', () => {
  it('Claude Code README mentions AIGENCY_BASE_URL and AIGENCY_API_KEY', async () => {
    const text = await readFile(CLAUDE_CODE_README, 'utf-8')

    assert.ok(
      text.includes('AIGENCY_BASE_URL'),
      'Claude Code README must mention AIGENCY_BASE_URL',
    )
    assert.ok(
      text.includes('AIGENCY_API_KEY'),
      'Claude Code README must mention AIGENCY_API_KEY',
    )
  })

  it('aider README mentions AIGENCY_BASE_URL and AIGENCY_API_KEY', async () => {
    const text = await readFile(AIDER_README, 'utf-8')

    assert.ok(
      text.includes('AIGENCY_BASE_URL'),
      'aider README must mention AIGENCY_BASE_URL',
    )
    assert.ok(
      text.includes('AIGENCY_API_KEY'),
      'aider README must mention AIGENCY_API_KEY',
    )
  })
})

// ---------------------------------------------------------------------------
// 4. TS SDK — smoke test (dynamic import)
// ---------------------------------------------------------------------------
describe('TS SDK smoke test', () => {
  it('index.ts exports AigencyClient', async () => {
    const mod = await import(TS_SDK_INDEX)

    assert.ok(mod.AigencyClient, 'AigencyClient must be exported from the TS SDK')
    assert.equal(typeof mod.AigencyClient, 'function', 'AigencyClient must be a class/constructor')
  })
})

// ---------------------------------------------------------------------------
// 5. Python SDK — smoke test (static parse of __init__.py)
// ---------------------------------------------------------------------------
describe('Python SDK smoke test', () => {
  it('__init__.py references AigencyClient', async () => {
    const text = await readFile(PY_SDK_INIT, 'utf-8')

    assert.ok(
      text.includes('AigencyClient'),
      'Python SDK __init__.py must export/reference AigencyClient',
    )
  })
})
