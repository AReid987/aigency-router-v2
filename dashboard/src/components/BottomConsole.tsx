export default function BottomConsole() {
  return (
    <div className="w-full h-full font-mono text-xs overflow-auto">
      <div className="text-phosphor-amber text-sm mb-1 tracking-widest border-b border-crt-300 pb-1">
        SYSTEM CONSOLE
      </div>
      <div className="text-crt-400">
        <span className="text-phosphor-green">{'>'}</span> Holo-CRT initialized. Awaiting engine connection...
      </div>
    </div>
  );
}
