import { useTelemetry } from './hooks/useTelemetry'
import RadarCanvas from './components/RadarCanvas'
import SwarmTelemetry from './components/SwarmTelemetry'
import ObservabilityDeck from './components/ObservabilityDeck'
import BottomConsole from './components/BottomConsole'

export default function App() {
  // Mount telemetry SSE connection at top level
  useTelemetry()

  return (
    <div className="w-screen h-screen bg-void font-mono grid grid-cols-[20%_1fr_20%] grid-rows-[1fr_20%] gap-px bg-crt-200">
      {/* Left Panel */}
      <div className="bg-void p-2 overflow-hidden">
        <SwarmTelemetry />
      </div>

      {/* Center Stage */}
      <div className="bg-void overflow-hidden">
        <RadarCanvas />
      </div>

      {/* Right Panel */}
      <div className="bg-void p-2 overflow-hidden">
        <ObservabilityDeck />
      </div>

      {/* Bottom Console */}
      <div className="col-span-3 bg-void p-2 border-t border-crt-300 overflow-hidden">
        <BottomConsole />
      </div>
    </div>
  )
}
