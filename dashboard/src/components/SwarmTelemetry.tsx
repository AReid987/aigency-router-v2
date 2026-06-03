import { useEffect, useRef } from 'react'
import { useTelemetryStore } from '../store/telemetry'

const CLASS_COLORS: Record<string, string> = {
  FAST_TRACK_ROUTE: 'text-phosphor-green',
  DRIFT_HEALED: 'text-phosphor-amber',
  PROVIDER_FAILOVER: 'text-phosphor-red',
  SWARM_DECOMPOSITION: 'text-phosphor-blue',
}

const DEFAULT_COLOR = 'text-crt-400'

function formatTime(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toLocaleTimeString('en-US', { hour12: false })
  } catch {
    return ts.slice(11, 19)
  }
}

export default function SwarmTelemetry() {
  const events = useTelemetryStore((s) => s.events)
  const connected = useTelemetryStore((s) => s.connected)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [events])

  return (
    <div className="w-full h-full font-mono text-xs overflow-hidden flex flex-col">
      <div className="text-phosphor-amber text-sm mb-2 tracking-widest border-b border-crt-300 pb-1 flex items-center justify-between shrink-0">
        <span>SWARM TELEMETRY</span>
        <span className={`text-[10px] ${connected ? 'text-phosphor-green' : 'text-phosphor-red'}`}>
          {connected ? '● SSE' : '○ SSE'}
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-0.5 pr-1">
        {events.length === 0 ? (
          <div className="text-crt-400 italic text-[11px]">
            Awaiting worker events...
          </div>
        ) : (
          events.slice(0, 50).map((ev) => {
            const colorClass = CLASS_COLORS[ev.event_class] ?? DEFAULT_COLOR
            return (
              <div key={ev.log_id} className={`${colorClass} leading-tight`}>
                <span className="text-crt-500">{formatTime(ev.timestamp)}</span>
                {' '}
                <span className="font-bold">[{ev.event_class}]</span>
                {' '}
                <span className="text-crt-400">{ev.source_worker}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
