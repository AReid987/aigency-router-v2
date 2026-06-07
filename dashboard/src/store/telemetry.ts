import { create } from 'zustand'

export interface SugarEvent {
  log_id: number
  timestamp: string
  event_class: string
  source_worker: string
  payload_snapshot: string
}

interface TelemetryState {
  events: SugarEvent[]
  connected: boolean
  addEvent: (event: SugarEvent) => void
  setConnected: (connected: boolean) => void
  classCounts: () => Record<string, number>
}

const MAX_EVENTS = 100

export const useTelemetryStore = create<TelemetryState>((set, get) => ({
  events: [],
  connected: false,

  addEvent: (event: SugarEvent) =>
    set((state) => ({
      events: [event, ...state.events].slice(0, MAX_EVENTS),
    })),

  setConnected: (connected: boolean) => set({ connected }),

  classCounts: () => {
    const counts: Record<string, number> = {}
    for (const event of get().events) {
      counts[event.event_class] = (counts[event.event_class] ?? 0) + 1
    }
    return counts
  },
}))
