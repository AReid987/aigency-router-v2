import { useTelemetryStore } from '../store/telemetry'

interface QuotaInfo {
  provider: string
  keyCount: number
  usagePercent: number
}

function barColor(pct: number): string {
  if (pct > 95) return 'bg-phosphor-red'
  if (pct > 80) return 'bg-phosphor-amber'
  return 'bg-phosphor-green'
}

function textColor(pct: number): string {
  if (pct > 95) return 'text-phosphor-red'
  if (pct > 80) return 'text-phosphor-amber'
  return 'text-phosphor-green'
}

function QuotaBar({ info }: { info: QuotaInfo }) {
  const pct = Math.min(100, Math.max(0, info.usagePercent))
  return (
    <div className="mb-2">
      <div className="flex justify-between items-baseline mb-0.5">
        <span className="text-crt-600 text-[11px] uppercase tracking-wide">{info.provider}</span>
        <span className={`${textColor(pct)} text-[10px]`}>
          {info.keyCount} key{info.keyCount !== 1 ? 's' : ''} · {pct.toFixed(0)}%
        </span>
      </div>
      <div className="w-full h-2 bg-crt-100 rounded-sm overflow-hidden">
        <div
          className={`h-full ${barColor(pct)} transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export default function ObservabilityDeck() {
  const events = useTelemetryStore((s) => s.events)

  // Extract latest quota info per provider from QUOTA_WARNING events
  const quotas: QuotaInfo[] = (() => {
    const byProvider = new Map<string, QuotaInfo>()
    for (const ev of events) {
      if (ev.event_class !== 'QUOTA_WARNING') continue
      try {
        const payload = JSON.parse(ev.payload_snapshot)
        const provider = payload.provider ?? ev.source_worker ?? 'unknown'
        if (!byProvider.has(provider)) {
          byProvider.set(provider, {
            provider,
            keyCount: payload.key_count ?? 1,
            usagePercent: payload.usage_percent ?? 0,
          })
        }
      } catch {
        // skip malformed
      }
    }
    return Array.from(byProvider.values())
  })()

  return (
    <div className="w-full h-full font-mono text-phosphor-amber text-xs overflow-auto">
      <div className="text-sm mb-2 tracking-widest border-b border-crt-300 pb-1">
        OBSERVABILITY
      </div>

      {quotas.length === 0 ? (
        <div className="text-crt-400 italic text-[11px]">
          No quota events yet. Waiting for QUOTA_WARNING...
        </div>
      ) : (
        <div>
          <div className="text-[10px] text-crt-500 uppercase tracking-widest mb-1">
            API Key Quotas
          </div>
          {quotas.map((q) => (
            <QuotaBar key={q.provider} info={q} />
          ))}
        </div>
      )}
    </div>
  )
}
