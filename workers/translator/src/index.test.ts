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
