# **Aigency OS (Voltron Release): Comprehensive UI/UX Specification**

**Date:** May 7, 2026  
**Version:** 5.0.0 (Voltron Core)  
**Target Context:** Autonomous Agent Swarm Orchestration

## **1\. Dual Interface Philosophy**

The Aigency OS discards the traditional "SaaS Dashboard" paradigm in favor of a specialized **Dual Interface Strategy**. The system must accommodate two radically different modes of operation:

1. **The Command Plane (TUI):** A zero-latency, keyboard-driven interface optimized for SSH, mobile access, and secure data entry. It is designed for the "Hacker" persona.  
2. **The Watchtower (Holo-CRT):** A skeuomorphic, highly visual WebGL dashboard designed for ambient observability. It is designed to visualize complex Directed Acyclic Graph (DAG) swarms that are too abstract to follow in a standard text log.

## **2\. Part I: The Command Plane (TUI)**

Built using Python's Textual and Typer, this interface is the sole method for managing the encrypted SugarVault and system configurations.

### **2.1 CLI Commands (Typer Interface)**

Before launching the full TUI, operators can execute direct commands. The root command is voltron.

| Command | Arguments/Flags | Action Description |
| :---- | :---- | :---- |
| `voltron start` | \--headless, \--port 8000 | Initializes the FastAPI brain and Node.js OmniGateway. Prompts for the SugarVault AES decryption password. |
| `voltron keys add` | \--provider groq | Opens a secure, masked prompt to inject a new API key directly into the SugarVault. |
| `voltron tui` | \--web-bridge | Launches the interactive Textual dashboard. \--web-bridge exposes it via xterm.js on port 8080\. |

### **2.2 Textual UI Layout & Hotkeys**

When running voltron tui, the terminal splits into a strict dual-pane layout.

* **Left Pane (70%): The Swarm Log.** Streams the OmniGateway routing logs. Color coding: Green for Fast Track, Blue for DAG decomposition, Yellow for Schema Drift intercepts, Red for HTTP 429/5xx failovers.  
* **Right Pane (30%): The Vault Matrix.** A live table of active keys grouped by "Virtual Colleague" ID. Shows current daily usage percentages.  
* **Global Hotkeys:**  
  * \[F1\] \- Toggle Log Verbosity (Info / Debug / Trace)  
  * \[F2\] \- Rotate Multiplexer Pool (Force shift to secondary keys)  
  * \[ESC\] \- Master Kill Switch (Aborts all active Axios requests in Node.js layer)

## **3\. Part II: The Watchtower (Holo-CRT Web UI)**

Built using React, Vite, TailwindCSS, and Three.js. It consumes Server-Sent Events (SSE) from the FastAPI backend (port 8000).

### **3.1 Visual Language & Color Palette**

The aesthetic is "Analog Substrate, Digital Hologram." Strict color hex codes must be adhered to for maximum contrast against the void.

* **Void Background:** \#050505 (True Black)  
* **Local Phosphor (Primary):** \#FFB000 (Amber) \- Used for the Center Monolith, UI chrome, text, and SugarDB/SugarVault nodes.  
* **Cloud Phosphor (Success):** \#00FF41 (Cyber Green) \- Used for external provider orbits (Groq, Cerebras) and successful Fast Track traces.  
* **Alert Phosphor (Failure):** \#FF003C (Crimson Red) \- Used for Judge Rejections, Kautilya security flags, and Dead/Rate-limited API keys.

### **3.2 Post-Processing & Shaders (Three.js)**

To achieve the "CRT" look, the WebGL canvas must implement a specific post-processing pipeline:

1. **UnrealBloomPass:** Threshold: 0.1, Strength: 1.5, Radius: 0.4. (Makes the phosphor colors glow).  
2. **Custom Scanline Shader:** Interleaves a subtle horizontal black line across the canvas based on screen resolution.  
3. **Lens Distortion (Chromatic Aberration):** A slight RGB split applied only to the outer 10% of the viewport radius to simulate curved glass.

### **3.3 Event-Driven Animations**

The UI must react loudly to the aigency\_telemetry chunks injected into the SSE stream.

| Telemetry Event | Watchtower Visual Reaction |
| :---- | :---- |
| FAST\_TRACK\_ROUTE | A sharp, instantaneous Green laser-line arcs directly from the Center Monolith to an Outer Orbit cloud node (e.g., the Groq node). |
| SWARM\_DECOMPOSITION | The Center Monolith fractures into N smaller glowing orbs (representing parallel DAG tasks). Orbs scatter to various nodes simultaneously. |
| DRIFT\_HEALED | A rapid Amber pulse travels between the Monolith and a fast-tier node. The Left Panel terminal types \[ENGRAM: DRIFT CORRECTED\] in bright amber text. |
| JUDGE\_REJECTION | The floating Judge Pyramid flashes Crimson Red. The UI emits a slight camera shake (displacement mapping). A red tracer beam bounces back to the swarm cluster to initiate the retry loop. |

## **4\. Frontend Grid Structure (React)**

The layout is a strict, unscrollable 100vh SPA grid.

* **Center Stage (60% Width, 80% Height):** The \<RadarCanvas /\> component (Three.js).  
* **Left Panel (20% Width, 100% Height):** The \<SwarmTelemetry /\> component. A fast-scrolling monospace text terminal outputting the SSE log.  
* **Right Panel (20% Width, 100% Height):** The \<ObservabilityDeck /\> component. Renders SVG progress bars representing the QuotaTracker limits for the active keys.  
* **Bottom Console (60% Width, 20% Height):** Absolute positioned over the bottom-center of the canvas. Contains the HTML/CSS tactile toggle switches for Orchestration Modes (Auto, Deep Swarm, Fast Track).