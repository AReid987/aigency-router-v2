import { useState } from 'react'

const MODES = [
  { id: 'auto', label: 'AUTO', description: 'Adaptive routing' },
  { id: 'deep-swarm', label: 'DEEP SWARM', description: 'Multi-provider parallel' },
  { id: 'fast-track', label: 'FAST TRACK', description: 'Low-latency direct' },
] as const

type ModeId = (typeof MODES)[number]['id']

export default function BottomConsole() {
  const [activeMode, setActiveMode] = useState<ModeId>('auto')

  return (
    <div className="w-full h-full font-mono text-xs overflow-auto flex items-center gap-4">
      <div className="text-phosphor-amber text-sm tracking-widest border-r border-crt-300 pr-4 shrink-0">
        SYSTEM CONSOLE
      </div>

      <div className="flex items-center gap-2">
        <span className="text-crt-500 text-[10px] uppercase tracking-widest mr-1">Mode:</span>
        {MODES.map((mode) => {
          const isActive = activeMode === mode.id
          return (
            <button
              key={mode.id}
              onClick={() => setActiveMode(mode.id)}
              className={`
                px-3 py-1 text-[11px] uppercase tracking-wider border transition-all duration-200
                ${isActive
                  ? 'bg-phosphor-amber/15 border-phosphor-amber text-phosphor-amber shadow-crt-glow'
                  : 'bg-transparent border-crt-300 text-crt-500 hover:border-crt-400 hover:text-crt-600'
                }
              `}
              title={mode.description}
            >
              {mode.label}
            </button>
          )
        })}
      </div>

      <div className="ml-auto text-crt-400 text-[10px]">
        <span className="text-phosphor-green">{'>'}</span> Holo-CRT v0.1 · Aigency OS
      </div>
    </div>
  )
}
