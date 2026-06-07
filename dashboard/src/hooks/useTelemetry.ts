import { useEffect, useRef } from 'react'
import { useTelemetryStore, type SugarEvent } from '../store/telemetry'

const SSE_URL = import.meta.env.VITE_SSE_URL ?? 'http://127.0.0.1:3115/events'
const RECONNECT_DELAY_MS = 3000

/**
 * Hook that connects to the SugarDB SSE endpoint and feeds events
 * into the Zustand store. Handles reconnection automatically.
 */
export function useTelemetry() {
  const addEvent = useTelemetryStore((s) => s.addEvent)
  const setConnected = useTelemetryStore((s) => s.setConnected)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    let alive = true

    function connect() {
      const es = new EventSource(SSE_URL)
      esRef.current = es

      es.onopen = () => {
        if (alive) setConnected(true)
      }

      es.onmessage = (ev: MessageEvent) => {
        if (!alive) return
        try {
          const event: SugarEvent = JSON.parse(ev.data)
          addEvent(event)
        } catch {
          // Non-JSON messages (like :ok comment) are ignored
        }
      }

      es.onerror = () => {
        if (alive) {
          setConnected(false)
          es.close()
          // Reconnect after delay
          setTimeout(() => {
            if (alive) connect()
          }, RECONNECT_DELAY_MS)
        }
      }
    }

    connect()

    return () => {
      alive = false
      esRef.current?.close()
    }
  }, [addEvent, setConnected])
}
