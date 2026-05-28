# Story 4.5: Observability Integration

**Overview Description:** Consume the SSE stream in the React frontend to trigger visual state changes, laser animations, and populate the telemetry terminal UI.

**Complexity Score:** 8

**Dependencies:** Story 4.3, Story 4.4

**Developer Guidance:** Use React state or a lightweight store (Zustand) to listen for the `aigency_telemetry` chunks in the SSE stream. Map specific event flags (e.g., `DRIFT_HEALED`) to Three.js imperative animations.

### Checkbox Tasklist:
* [ ] Implement `EventSource` listener to connect to FastAPI port 8000.
* [ ] Parse incoming telemetry chunks and pipe text to the Left Panel `<SwarmTelemetry />` component.
* [ ] Trigger visual animations (lasers, pulses) based on telemetry status flags.

### Acceptance Criteria:
* A mock `FAST_TRACK` SSE event sent from the backend successfully triggers a green laser trace across the 3D canvas and updates the side terminal logs.

### Resource URLs:
* Zustand State Management: [https://zustand-demo.pmnd.rs/](https://zustand-demo.pmnd.rs/)
