export default function SwarmTelemetry() {
  return (
    <div className="w-full h-full font-mono text-phosphor-green text-xs overflow-auto">
      <div className="text-phosphor-amber text-sm mb-2 tracking-widest border-b border-crt-300 pb-1">
        SWARM TELEMETRY
      </div>
      <div className="text-crt-400 italic">
        Awaiting worker events...
      </div>
    </div>
  );
}
