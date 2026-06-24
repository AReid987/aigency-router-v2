import { describe, it, mock, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

// Mock child_process.spawn before importing the module under test
const mockSpawn = mock.fn()

mock.module('node:child_process', {
  namedExports: { spawn: mockSpawn },
})

// Mock node:fs for existsSync
const mockExistsSync = mock.fn()
mock.module('node:fs', {
  namedExports: { existsSync: mockExistsSync },
})

const { classifyViaLlama, extractClassificationJson, isLlamaBinaryAvailable, isModelAvailable, getDefaultModelPath } = await import('./llama-client.ts')

/**
 * Create a mock child process with controllable stdout/stderr/exit.
 */
function createMockChild() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = new EventEmitter() as any
  child.stdout = stdout
  child.stderr = stderr
  child.kill = mock.fn(() => true)
  return { child, stdout, stderr }
}

describe('extractClassificationJson', () => {
  it('extracts JSON from clean output', () => {
    const raw = '{"classification": "simple", "reason": "short"}'
    const result = extractClassificationJson(raw)
    assert.equal(result, raw)
  })

  it('extracts JSON from mixed output with model text before', () => {
    const raw = 'Here is the classification result:\n{"classification": "complex", "reason": "multi-turn"}\n\nllama_print_timings:'
    const result = extractClassificationJson(raw)
    assert.ok(result.includes('"classification": "complex"'))
  })

  it('extracts JSON from output with timing stats', () => {
    const raw = [
      '{"classification": "simple", "reason": "basic"}',
      '',
      'llama_print_timings:        load time =     123.45 ms',
      'llama_print_timings:      prompt time =      45.67 ms',
    ].join('\n')
    const result = extractClassificationJson(raw)
    assert.ok(result.includes('"classification": "simple"'))
  })

  it('extracts JSON with extra whitespace and newlines', () => {
    const raw = '{\n  "classification": "simple",\n  "reason": "test"\n}'
    const result = extractClassificationJson(raw)
    assert.ok(result.includes('"classification": "simple"'))
  })

  it('throws when no valid classification JSON exists', () => {
    assert.throws(
      () => extractClassificationJson('no json here'),
      (err: Error) => {
        assert.match(err.message, /no valid classification json/i)
        return true
      },
    )
  })

  it('throws when JSON has wrong classification value', () => {
    assert.throws(
      () => extractClassificationJson('{"classification": "medium"}'),
      (err: Error) => {
        assert.match(err.message, /no valid classification json/i)
        return true
      },
    )
  })
})

describe('classifyViaLlama', () => {
  beforeEach(() => {
    mockSpawn.mock.resetCalls()
    mockExistsSync.mock.resetCalls()
  })

  it('returns classification JSON on successful inference', async () => {
    const { child, stdout } = createMockChild()
    mockSpawn.mock.mockImplementation(() => {
      // Write output and exit asynchronously
      process.nextTick(() => {
        stdout.write('{"classification": "simple", "reason": "basic prompt"}')
        stdout.end()
        child.emit('exit', 0, null)
      })
      return child
    })

    const result = await classifyViaLlama('/path/to/model.gguf', 'test prompt', {
      timeoutMs: 5000,
    })

    assert.ok(result.includes('"classification": "simple"'))
    assert.equal(mockSpawn.mock.callCount(), 1)
    const call = mockSpawn.mock.calls[0]
    assert.equal(call.arguments[0], 'llama-cli')
    assert.ok(call.arguments[1].includes('-m'))
    assert.ok(call.arguments[1].includes('/path/to/model.gguf'))
  })

  it('rejects with timeout when process takes too long', async () => {
    const { child } = createMockChild()
    mockSpawn.mock.mockImplementation(() => {
      // Don't emit exit — let the timeout fire
      return child
    })

    await assert.rejects(
      () => classifyViaLlama('/path/to/model.gguf', 'slow prompt', { timeoutMs: 50 }),
      (err: Error) => {
        assert.match(err.message, /timeout/i)
        return true
      },
    )
  })

  it('rejects with ENOENT when binary not found', async () => {
    const { child } = createMockChild()
    mockSpawn.mock.mockImplementation(() => {
      process.nextTick(() => {
        const err = new Error('spawn ENOENT') as NodeJS.ErrnoException
        err.code = 'ENOENT'
        child.emit('error', err)
      })
      return child
    })

    await assert.rejects(
      () => classifyViaLlama('/path/to/model.gguf', 'test', { binaryPath: '/nonexistent/llama' }),
      (err: Error) => {
        assert.match(err.message, /binary not found/i)
        return true
      },
    )
  })

  it('rejects when output contains no valid JSON', async () => {
    const { child, stdout } = createMockChild()
    mockSpawn.mock.mockImplementation(() => {
      process.nextTick(() => {
        stdout.write('I cannot classify this request. Here is some text.')
        stdout.end()
        child.emit('exit', 0, null)
      })
      return child
    })

    await assert.rejects(
      () => classifyViaLlama('/path/to/model.gguf', 'test', { timeoutMs: 5000 }),
      (err: Error) => {
        assert.match(err.message, /no valid classification json/i)
        return true
      },
    )
  })

  it('rejects when process exits with non-zero code', async () => {
    const { child, stderr } = createMockChild()
    mockSpawn.mock.mockImplementation(() => {
      process.nextTick(() => {
        stderr.write('Error: model file not found')
        stderr.end()
        child.emit('exit', 1, null)
      })
      return child
    })

    await assert.rejects(
      () => classifyViaLlama('/path/to/model.gguf', 'test', { timeoutMs: 5000 }),
      (err: Error) => {
        assert.match(err.message, /exited with code 1/i)
        return true
      },
    )
  })

  it('extracts JSON from mixed output with model text before classification', async () => {
    const { child, stdout } = createMockChild()
    mockSpawn.mock.mockImplementation(() => {
      process.nextTick(() => {
        stdout.write('Based on the request parameters, here is my analysis:\n')
        stdout.write('{"classification": "complex", "reason": "multi-turn conversation with JSON enforcement"}\n')
        stdout.write('\nllama_print_timings:        load time =     45.12 ms')
        stdout.end()
        child.emit('exit', 0, null)
      })
      return child
    })

    const result = await classifyViaLlama('/path/to/model.gguf', 'test', { timeoutMs: 5000 })

    const parsed = JSON.parse(result)
    assert.equal(parsed.classification, 'complex')
  })

  it('uses default config values when none provided', async () => {
    const { child, stdout } = createMockChild()
    mockSpawn.mock.mockImplementation(() => {
      process.nextTick(() => {
        stdout.write('{"classification": "simple", "reason": "ok"}')
        stdout.end()
        child.emit('exit', 0, null)
      })
      return child
    })

    await classifyViaLlama('/model.gguf', 'prompt')

    const call = mockSpawn.mock.calls[0]
    const args = call.arguments[1] as string[]
    // Check default args: -n 64, --temp 0, -t 4
    assert.ok(args.includes('-n'))
    assert.ok(args.includes('64'))
    assert.ok(args.includes('--temp'))
    assert.ok(args.includes('0'))
    assert.ok(args.includes('-t'))
    assert.ok(args.includes('4'))
    assert.ok(args.includes('--no-display-prompt'))
    assert.ok(args.includes('--log-disable'))
  })
})

describe('getDefaultModelPath', () => {
  const originalEnv = process.env.SLM_MODEL_PATH

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.SLM_MODEL_PATH
    } else {
      process.env.SLM_MODEL_PATH = originalEnv
    }
  })

  it('returns env var path when SLM_MODEL_PATH is set', () => {
    process.env.SLM_MODEL_PATH = '/custom/path/model.gguf'
    const path = getDefaultModelPath()
    assert.equal(path, '/custom/path/model.gguf')
  })

  it('returns default path when SLM_MODEL_PATH is not set', () => {
    delete process.env.SLM_MODEL_PATH
    const path = getDefaultModelPath()
    assert.ok(path.endsWith('.models/qwen2.5-0.5b-instruct-q4_k_m.gguf'))
  })
})
