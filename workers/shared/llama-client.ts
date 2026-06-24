/**
 * LlamaCppClient — subprocess wrapper for llama-cli binary.
 *
 * Spawns llama-cli as a child process, collects stdout, extracts
 * classification JSON from mixed output (model text + timing stats).
 * Replaces Ollama SDK dependency for local SLM inference.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export interface LlamaClientConfig {
  /** Path to the llama-cli binary. Default: 'llama-cli' (resolved from PATH). */
  binaryPath?: string
  /** Inference timeout in milliseconds. Default: 2000 */
  timeoutMs?: number
  /** Number of threads to use. Default: 4 */
  threads?: number
  /** Sampling temperature. Default: 0 */
  temperature?: number
  /** Max tokens to generate. Default: 64 */
  maxTokens?: number
}

const DEFAULT_CONFIG: Required<LlamaClientConfig> = {
  binaryPath: 'llama-cli',
  timeoutMs: 2000,
  threads: 4,
  temperature: 0,
  maxTokens: 64,
}

/**
 * Get the default model path from env or fallback.
 */
export function getDefaultModelPath(): string {
  const envPath = process.env.SLM_MODEL_PATH
  if (envPath) return resolve(envPath)
  return resolve(homedir(), '.models', 'qwen2.5-0.5b-instruct-q4_k_m.gguf')
}

/**
 * Check if the llama-cli binary is available on the system.
 */
export function isLlamaBinaryAvailable(binaryPath = DEFAULT_CONFIG.binaryPath): boolean {
  // For absolute paths, check existence directly
  if (binaryPath.startsWith('/') || binaryPath.startsWith('~')) {
    return existsSync(resolve(binaryPath.replace('~', homedir())))
  }
  // For bare names (resolved via PATH), use a sync spawn to check
  try {
    const { execSync } = require('node:child_process')
    execSync(`command -v ${binaryPath}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Check if the GGUF model file exists at the given path.
 */
export function isModelAvailable(modelPath?: string): boolean {
  const path = modelPath ?? getDefaultModelPath()
  return existsSync(path)
}

/**
 * Regex to extract a classification JSON object from mixed llama-cli output.
 * Handles: model text before/after JSON, timing stats, newlines.
 */
const CLASSIFICATION_JSON_RE = /\{[\s\S]*?"classification"\s*:\s*"(?:simple|complex)"[\s\S]*?\}/

/**
 * Extract classification JSON from raw llama-cli stdout.
 *
 * The output may contain model-generated text, timing stats, and other noise.
 * We look for the first JSON object containing a valid "classification" field.
 */
export function extractClassificationJson(raw: string): string {
  const match = raw.match(CLASSIFICATION_JSON_RE)
  if (!match) {
    throw new Error(`No valid classification JSON found in output: ${raw.slice(0, 200)}`)
  }
  return match[0]
}

/**
 * Classify a prompt via llama-cli subprocess.
 *
 * Spawns llama-cli, collects stdout, extracts classification JSON,
 * and returns the parsed classification string.
 *
 * @param modelPath - Path to the GGUF model file
 * @param prompt - The classification prompt
 * @param config - Optional overrides for binary path, timeout, etc.
 * @returns The classification string ('simple' or 'complex')
 * @throws {Error} on timeout, ENOENT, or malformed output
 */
export async function classifyViaLlama(
  modelPath: string,
  prompt: string,
  config: LlamaClientConfig = {},
): Promise<string> {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const args = [
    '-m', modelPath,
    '-p', prompt,
    '-n', String(cfg.maxTokens),
    '--no-display-prompt',
    '--temp', String(cfg.temperature),
    '-t', String(cfg.threads),
    '--log-disable',
  ]

  return new Promise<string>((resolve, reject) => {
    const child = spawn(cfg.binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`llama-cli timeout after ${cfg.timeoutMs}ms`))
    }, cfg.timeoutMs)

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (err.code === 'ENOENT') {
        reject(new Error(`llama-cli binary not found: ${cfg.binaryPath}`))
      } else {
        reject(new Error(`llama-cli spawn error: ${err.message}`))
      }
    })

    child.on('exit', (code, signal) => {
      clearTimeout(timer)

      if (signal === 'SIGKILL') {
        // Timeout already rejected — don't double-reject
        return
      }

      if (code !== 0) {
        // Log raw output at debug level for diagnostics
        console.debug(`[llama-client] raw stdout: ${stdout.slice(0, 500)}`)
        reject(new Error(`llama-cli exited with code ${code}: ${stderr.slice(0, 200)}`))
        return
      }

      try {
        const jsonStr = extractClassificationJson(stdout)
        resolve(jsonStr)
      } catch (err) {
        // Log raw output at debug level when extraction fails
        console.debug(`[llama-client] raw stdout: ${stdout.slice(0, 500)}`)
        reject(err)
      }
    })
  })
}
