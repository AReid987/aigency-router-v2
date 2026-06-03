import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('translator worker module', () => {
  it('exports createTranslatorWorker function', async () => {
    const { createTranslatorWorker } = await import('./index.ts')
    assert.equal(typeof createTranslatorWorker, 'function')
  })

  it('createTranslatorWorker is callable', async () => {
    const { createTranslatorWorker } = await import('./index.ts')
    assert.ok(createTranslatorWorker instanceof Function)
  })
})

describe('resolveModel', () => {
  let resolveModel: (model: string) => { model: string; providers: string[]; resolved: boolean }

  it('imports resolveModel', async () => {
    const mod = await import('./index.ts')
    resolveModel = mod.resolveModel
    assert.equal(typeof resolveModel, 'function')
  })

  it('resolves known canonical model "llama3"', () => {
    const result = resolveModel('llama3')
    assert.deepEqual(result, {
      model: 'llama3',
      providers: [
        'groq/llama3-8b-8192',
        'cerebras/llama3.1-8b',
        'together/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
      ],
      resolved: true,
    })
  })

  it('resolves known canonical model "llama3-70b"', () => {
    const result = resolveModel('llama3-70b')
    assert.deepEqual(result, {
      model: 'llama3-70b',
      providers: [
        'groq/llama-3.3-70b-versatile',
        'together/meta-llama/Llama-3.3-70B-Instruct-Turbo',
      ],
      resolved: true,
    })
  })

  it('resolves known canonical model "gpt-oss"', () => {
    const result = resolveModel('gpt-oss')
    assert.deepEqual(result, {
      model: 'gpt-oss',
      providers: [
        'cerebras/gpt-oss-120b',
        'groq/openai/gpt-oss-20b',
        'together/openai/gpt-oss-120b',
      ],
      resolved: true,
    })
  })

  it('passes through unknown model with resolved=false', () => {
    const result = resolveModel('mistral-7b')
    assert.deepEqual(result, {
      model: 'mistral-7b',
      providers: ['mistral-7b'],
      resolved: false,
    })
  })

  it('returns resolved=false for empty string', () => {
    const result = resolveModel('')
    assert.deepEqual(result, {
      model: '',
      providers: [],
      resolved: false,
    })
  })

  it('returns resolved=false for whitespace-only string', () => {
    const result = resolveModel('   ')
    assert.deepEqual(result, {
      model: '   ',
      providers: [],
      resolved: false,
    })
  })
})

// ── Telemetry Tests ────────────────────────────────────────────────────

describe('translator telemetry emission', () => {
  it('emits PROVIDER_RESOLVED telemetry on provider resolution', async () => {
    const { logTelemetry } = await import('../../shared/telemetry.ts')

    let emittedEvent: string | undefined
    let emittedPayload: any
    const mockTrigger = async (_target: string, _fnName: string, input: any) => {
      emittedEvent = input?.eventClass
      emittedPayload = input
      return {}
    }

    await logTelemetry({ trigger: mockTrigger }, {
      eventClass: 'PROVIDER_RESOLVED',
      sourceWorker: 'translator',
      payload: { model: 'llama3', resolved: true, providerCount: 3 },
    })

    assert.equal(emittedEvent, 'PROVIDER_RESOLVED')
    assert.equal(emittedPayload.sourceWorker, 'translator')
    assert.equal(emittedPayload.payload.model, 'llama3')
    assert.equal(emittedPayload.payload.resolved, true)
    assert.equal(emittedPayload.payload.providerCount, 3)
  })

  it('logTelemetry gracefully handles trigger failure', async () => {
    const { logTelemetry } = await import('../../shared/telemetry.ts')

    const warnLogs: string[] = []
    const origWarn = console.warn
    console.warn = (...args: any[]) => warnLogs.push(args.join(' '))

    try {
      const failingTrigger = async () => { throw new Error('connection refused') }
      await logTelemetry({ trigger: failingTrigger }, {
        eventClass: 'PROVIDER_RESOLVED',
        sourceWorker: 'translator',
        payload: { model: 'test', resolved: false, providerCount: 0 },
      })
      assert.ok(warnLogs.some(l => l.includes('connection refused')), 'should log warning on failure')
    } finally {
      console.warn = origWarn
    }
  })
})
