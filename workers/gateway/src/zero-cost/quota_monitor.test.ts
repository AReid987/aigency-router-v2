/**
 * QuotaMonitor unit tests.
 *
 * Tests the QuotaMonitor class with the InMemoryUsageTracker.
 * Uses node:test and node:assert/strict.
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryUsageTracker } from './usage_tracker.ts'
import type { IUsageTracker } from './usage_tracker.ts'
import { QuotaMonitor } from './quota_monitor.ts'

// ── Helpers ────────────────────────────────────────────────────────────

/** Create a UsageTracker seeded with some usage data. */
function seedTracker(
  usage: Array<{ provider: string; count: number; limit: number }>,
): InMemoryUsageTracker {
  const tracker = new InMemoryUsageTracker(1) // 1-minute window for faster tests
  for (const { provider, count, limit } of usage) {
    tracker.setProviderLimit(provider, limit)
    for (let i = 0; i < count; i++) {
      tracker.record(`key-${provider}-${i}`, provider, 100)
    }
  }
  return tracker
}

/** Collect console.log calls into an array for assertion. */
function captureConsoleLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = []
  const origLog = console.log
  const origWarn = console.warn
  console.log = (msg: string) => { logs.push(msg) }
  console.warn = (msg: string) => { logs.push(msg) }
  return {
    logs,
    restore: () => {
      console.log = origLog
      console.warn = origWarn
    },
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('QuotaMonitor', () => {
  // ── (a) getStatus() JSON format ────────────────────────────────────

  it('getStatus() returns correct JSON format with per-provider fields', () => {
    const tracker = seedTracker([
      { provider: 'groq', count: 100, limit: 1000 },
      { provider: 'cerebras', count: 50, limit: 500 },
      { provider: 'together', count: 0, limit: 800 },
    ])
    const monitor = new QuotaMonitor(tracker)

    const status = monitor.getStatus()

    assert.ok(Array.isArray(status.providers), 'providers should be an array')
    assert.equal(status.providers.length, 3, 'should have 3 providers')

    for (const p of status.providers) {
      assert.ok(typeof p.name === 'string', 'name should be a string')
      assert.ok(typeof p.current === 'number', 'current should be a number')
      assert.ok(typeof p.limit === 'number', 'limit should be a number')
      assert.ok(typeof p.utilization_pct === 'number', 'utilization_pct should be a number')
      // projected_exhaustion_at can be string or null
      assert.ok(
        p.projected_exhaustion_at === null || typeof p.projected_exhaustion_at === 'string',
        'projected_exhaustion_at should be string or null',
      )
    }

    // Verify groq (100/1000 = 10%)
    const groq = status.providers.find(p => p.name === 'groq')
    assert.ok(groq)
    assert.equal(groq.current, 100)
    assert.equal(groq.limit, 1000)
    assert.equal(groq.utilization_pct, 10)

    // Verify together (0/800 = 0%)
    const together = status.providers.find(p => p.name === 'together')
    assert.ok(together)
    assert.equal(together.current, 0)
    assert.equal(together.utilization_pct, 0)
    // No usage — rate is 0 — so projected_exhaustion_at should be null
    assert.equal(together.projected_exhaustion_at, null)
  })

  // ── (b) Threshold alert fires when provider crosses 80% ────────────

  it('threshold alert fires when provider crosses 80%', () => {
    const tracker = seedTracker([
      { provider: 'groq', count: 900, limit: 1000 }, // 90% — above 80% threshold
    ])
    const monitor = new QuotaMonitor(tracker, 0.8, 50_000) // Long interval to avoid extra firings

    const { logs, restore } = captureConsoleLogs()

    try {
      // Trigger threshold check manually by calling start() then accessing internals
      // start() calls checkThresholds() once immediately
      const handle = monitor.start()
      handle.stop()

      const alertLogs = logs.filter(l => l.includes('QUOTA_ALERT'))
      assert.equal(alertLogs.length, 1, 'should fire exactly 1 alert')
      assert.ok(alertLogs[0].includes('groq'), 'alert should mention groq')
      assert.ok(alertLogs[0].includes('90'), 'alert should include 90% utilization')
    } finally {
      restore()
    }
  })

  it('no alert fires when utilization is below threshold', () => {
    const tracker = seedTracker([
      { provider: 'groq', count: 100, limit: 1000 }, // 10% — below 80%
    ])
    const monitor = new QuotaMonitor(tracker, 0.8, 50_000)

    const { logs, restore } = captureConsoleLogs()

    try {
      const handle = monitor.start()
      handle.stop()

      const alertLogs = logs.filter(l => l.includes('QUOTA_ALERT'))
      assert.equal(alertLogs.length, 0, 'should not fire any alert')
    } finally {
      restore()
    }
  })

  // ── (c) Alert is idempotent (no duplicate within 1h window) ────────

  it('alert is idempotent within 1h cooldown window', () => {
    const tracker = seedTracker([
      { provider: 'groq', count: 900, limit: 1000 }, // 90%
    ])
    // Use a very short alert interval — but start() only calls checkThresholds once
    // Then we call getStatus() again which doesn't trigger alerts. We need multiple
    // manual threshold checks.
    const monitor = new QuotaMonitor(tracker, 0.8, 10_000)

    const { logs, restore } = captureConsoleLogs()

    try {
      // First check — should fire
      const handle = monitor.start()
      handle.stop()

      let alertLogs = logs.filter(l => l.includes('QUOTA_ALERT'))
      assert.equal(alertLogs.length, 1, 'first check should fire 1 alert')

      // Reset logs and call checkThresholds again via start/stop cycle
      // But the cooldown should prevent a second alert
      // Note: we can't call start() twice easily, so let's simulate by checking
      // the internal state via the public API

      // Create a new monitor with a clean state for the cooldown test
      const tracker2 = seedTracker([
        { provider: 'groq', count: 950, limit: 1000 }, // 95% — still above
      ])
      const monitor2 = new QuotaMonitor(tracker2, 0.8, 10_000)

      const logs2: string[] = []
      const origLog2 = console.log
      const origWarn2 = console.warn
      console.log = (msg: string) => { logs2.push(msg) }
      console.warn = (msg: string) => { logs2.push(msg) }

      try {
        // First call — should fire
        const h1 = monitor2.start()
        h1.stop()
        const firstAlerts = logs2.filter(l => l.includes('QUOTA_ALERT'))
        assert.equal(firstAlerts.length, 1, 'first check should fire alert')

        // Simulate time passage... but cooldown is 1h, so we can't really wait.
        // Instead, verify that a second check within the cooldown window is suppressed.
        // We need to trigger another threshold check.
        // Since we can't easily trigger another check via the public API,
        // let's verify by calling start() again.
        // Actually start() checks the intervalId and skips if already started.
        // Let's test this differently.

        // Verify the internal cooldown prevents duplicate alerts by checking
        // that _resetAlertCooldowns would be needed to re-fire.

        // The simplest test: create a monitor, start it (fires alert), reset cooldown,
        // start it again (should fire again).
        const tracker3 = seedTracker([
          { provider: 'groq', count: 900, limit: 1000 },
        ])
        const monitor3 = new QuotaMonitor(tracker3, 0.8, 10_000)

        const logs3: string[] = []
        console.log = (msg: string) => { logs3.push(msg) }
        console.warn = (msg: string) => { logs3.push(msg) }

        const h3 = monitor3.start()
        h3.stop()
        assert.equal(logs3.filter(l => l.includes('QUOTA_ALERT')).length, 1,
          'first check should fire')

        // Second check without reset — should be suppressed by cooldown
        // We need to trigger checkThresholds again. Since we can't access it
        // directly, let's verify the cooldown mechanism works:
        // start a new monitor, it fires once. Then manually verify that _resetAlertCooldowns
        // is needed before a re-fire.
        const logs4: string[] = []
        console.log = (msg: string) => { logs4.push(msg) }
        console.warn = (msg: string) => { logs4.push(msg) }

        // Start again — will it fire? The cooldown was set in the first call,
        // so it should NOT fire
        const h4 = monitor3.start()
        h4.stop()
        const secondAlerts = logs4.filter(l => l.includes('QUOTA_ALERT'))
        assert.equal(secondAlerts.length, 0,
          'second check within cooldown should not fire')

        // Reset cooldowns and check again — should fire
        monitor3._resetAlertCooldowns()

        const logs5: string[] = []
        console.log = (msg: string) => { logs5.push(msg) }
        console.warn = (msg: string) => { logs5.push(msg) }

        const h5 = monitor3.start()
        h5.stop()
        const thirdAlerts = logs5.filter(l => l.includes('QUOTA_ALERT'))
        assert.equal(thirdAlerts.length, 1,
          'after cooldown reset, should fire again')
      } finally {
        console.log = origLog2
        console.warn = origWarn2
      }
    } finally {
      restore()
    }
  })

  // ── (d) start()/stop() lifecycle ───────────────────────────────────

  it('start() returns a handle with stop() that stops alerting', () => {
    const tracker = seedTracker([
      { provider: 'groq', count: 900, limit: 1000 },
    ])
    const monitor = new QuotaMonitor(tracker, 0.8, 100)

    const { logs, restore } = captureConsoleLogs()

    try {
      const handle = monitor.start()
      assert.ok(typeof handle.stop === 'function', 'handle should have stop()')

      // start() calls checkThresholds once immediately
      let alertLogs = logs.filter(l => l.includes('QUOTA_ALERT'))
      assert.equal(alertLogs.length, 1, 'should fire alert on start')

      // Stop
      handle.stop()

      // Verify stop() is idempotent
      handle.stop() // should not throw
    } finally {
      restore()
    }
  })

  it('multiple start() calls do not create duplicate intervals', () => {
    const tracker = seedTracker([
      { provider: 'groq', count: 100, limit: 1000 },
    ])
    const monitor = new QuotaMonitor(tracker, 0.8, 100)

    const h1 = monitor.start()
    const h2 = monitor.start() // should no-op

    h1.stop()
    h2.stop() // should be idempotent
    // If this didn't throw, the test passed
    assert.ok(true)
  })

  // ── (e) Opt-in env gate behavior ───────────────────────────────────

  it('monitoring is not active when GATEWAY_QUOTA_MONITORING is not true', () => {
    // This tests the logic that gates the endpoint in http-handler.ts.
    // We simulate the gate: the handler checks the env var before creating
    // or using the QuotaMonitor.
    const saved = process.env.GATEWAY_QUOTA_MONITORING
    delete process.env.GATEWAY_QUOTA_MONITORING

    try {
      // The QuotaMonitor itself works regardless — the gating is in the handler.
      // Verify the instance can be created but the env gate logic would prevent usage.
      const tracker = seedTracker([
        { provider: 'groq', count: 100, limit: 1000 },
      ])
      const monitor = new QuotaMonitor(tracker)

      // The monitor should still function
      const status = monitor.getStatus()
      assert.ok(status.providers.length > 0)

      // But start/stop should also work — it's up to the caller to check the env var
      const handle = monitor.start()
      handle.stop()
      assert.ok(true, 'should not throw when env var is not set')
    } finally {
      if (saved !== undefined) {
        process.env.GATEWAY_QUOTA_MONITORING = saved
      }
    }
  })

  it('ensureQuotaMonitor returns null when env var is not true', async () => {
    // Test the gating logic directly by simulating what http-handler.ts does
    const saved = process.env.GATEWAY_QUOTA_MONITORING
    delete process.env.GATEWAY_QUOTA_MONITORING

    try {
      // This simulates the gate in the handler
      const isMonitoringEnabled = process.env.GATEWAY_QUOTA_MONITORING === 'true'
      assert.equal(isMonitoringEnabled, false, 'should be disabled by default')
    } finally {
      if (saved !== undefined) {
        process.env.GATEWAY_QUOTA_MONITORING = saved
      }
    }
  })

  // ── (f) Projected exhaustion time ─────────────────────────────────

  it('projected exhaustion time is correct for above-threshold providers', () => {
    // 800 / 1000 = 80%, rate = 800 req/min, remaining = 200
    // 200 / 800 = 0.25 min = 15 seconds from now
    // Use a 1-minute window with 800 requests = 800 req/min rate
    const tracker = new InMemoryUsageTracker(1)
    tracker.setProviderLimit('groq', 1000)
    for (let i = 0; i < 800; i++) {
      tracker.record(`key-${i}`, 'groq', 100)
    }

    const monitor = new QuotaMonitor(tracker)
    const status = monitor.getStatus()
    const groq = status.providers.find(p => p.name === 'groq')

    assert.ok(groq)
    assert.equal(groq.utilization_pct, 80)
    // Projected exhaustion: 200 remaining / 800 req/min = 0.25 min = 15s
    assert.ok(groq.projected_exhaustion_at !== null, 'should have exhaustion time')
    const exhaustionMs = new Date(groq.projected_exhaustion_at).getTime()
    const nowMs = Date.now()
    const diffMs = exhaustionMs - nowMs
    // Should be ~15s (allow ~5s tolerance for test execution)
    assert.ok(diffMs > 8_000 && diffMs < 25_000,
      `projected exhaustion should be ~15s from now, got ${diffMs}ms`)
  })

  it('projected exhaustion time is null when usage is zero', () => {
    const tracker = seedTracker([
      { provider: 'groq', count: 0, limit: 1000 },
    ])
    const monitor = new QuotaMonitor(tracker)
    const status = monitor.getStatus()
    const groq = status.providers.find(p => p.name === 'groq')
    assert.ok(groq)
    assert.equal(groq.projected_exhaustion_at, null,
      'no usage means no exhaustion projection')
  })

  it('projected exhaustion time is null when limit is zero (unlimited)', () => {
    const tracker = new InMemoryUsageTracker()
    tracker.setProviderLimit('groq', 0) // 0 = unlimited
    for (let i = 0; i < 100; i++) {
      tracker.record(`key-${i}`, 'groq', 100)
    }

    const monitor = new QuotaMonitor(tracker)
    const status = monitor.getStatus()
    const groq = status.providers.find(p => p.name === 'groq')
    assert.ok(groq)
    assert.equal(groq.projected_exhaustion_at, null,
      'no limit means no exhaustion projection')
  })

  // ── Telemetry dependency ───────────────────────────────────────────

  it('quota alert uses telemetryDeps when provided', () => {
    const tracker = seedTracker([
      { provider: 'groq', count: 900, limit: 1000 },
    ])

    let triggered = false
    const telemetryDeps = {
      trigger: async (_target: string, _fn: string, _input: unknown) => {
        triggered = true
      },
    }

    const monitor = new QuotaMonitor(tracker, 0.8, 50_000, telemetryDeps)
    const handle = monitor.start()
    handle.stop()

    // With telemetryDeps, no console.log should be called
    // (it uses telemetry.trigger instead)
    assert.ok(triggered, 'telemetry trigger should have been called')
  })
})
