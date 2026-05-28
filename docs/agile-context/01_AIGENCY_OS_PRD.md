# **Aigency OS (Voltron Release): Product Requirements Document (PRD)**

**Date:** May 7, 2026  
**Document Status:** Final / Active Development  
**Target Context:** Autonomous Agent Swarm Orchestration

## **1\. Introduction & Product Scope**

This Product Requirements Document (PRD) details the exhaustive functional and non-functional requirements for the Voltron Release of the Aigency OS. This release pivots the system from a basic API proxy into a highly secure, dual-interface, local operating system for autonomous agent swarms. The core objectives are achieving zero-cost execution via strict free-tier multiplexing, enforcing zero plaintext API keys on disk, and providing sub-150ms heuristic routing.

## **2\. Target User Personas**

* **Primary: The Autonomous Agent (Machine Persona):** CLI tools (e.g., OpenClaw, Claude Code) that require a stable, OpenAI-compatible endpoint. They expect continuous uptime, canonical model naming conventions, and 100% valid JSON responses regardless of the underlying provider's stability.  
* **Secondary: The Operator (Human Persona):** The solo developer governing the system. Needs lightning-fast terminal access (TUI) for adding harvested API keys and managing configurations, alongside a visual dashboard (Holo-CRT) to monitor swarm health and DAG execution in real-time.

## **3\. Comprehensive User Stories & Acceptance Criteria**

### **3.1 Core Routing & Orchestration**

* **US1: Canonical Model Routing**  
  *As an autonomous agent, I need to request canonical models (e.g., llama3) and have the system translate and route it to the fastest available provider automatically.*  
  **Acceptance Criteria:** Given a request for "model": "llama3", the ModelTranslator must resolve this to an array (e.g., \["groq/llama3-8b-8192", "cerebras/llama3.1-8b"\]). The OmniGateway must select the active key with the lowest latency and highest remaining quota.  
* **US2: Heuristic Brain Classification**  
  *As the system, I need to evaluate incoming requests against 14 heuristic dimensions using a BitNet model to determine if the task should be routed to a fast API (Simple) or decomposed into a swarm (Complex).*  
  **Acceptance Criteria:** The BitNet vLLM engine must return a classification flag within 150ms. Prompts containing code-generation flags must trigger the Deep Swarm (Engram) pipeline.  
* **US3: Auto-Healing JSON (Engram Drift Corrector)**  
  *As the Engram engine, I must detect malformed JSON from open-source models and repair it using a fast fallback model before returning the payload to the agent.*  
  **Acceptance Criteria:** If JSON.parse() fails on a swarm node's output, Engram must automatically pause execution, wrap the broken string in a strict repair prompt, send it to the fastest available Groq endpoint, and successfully parse the corrected response.

### **3.2 Quota & Security Management**

* **US4: SugarVault Encryption**  
  *As the solo developer, I want to store my harvested API keys in an encrypted SQLite database (SugarVault) instead of plaintext .env files to maintain strict security.*  
  **Acceptance Criteria:** The database must use AES-256-GCM encryption. Keys must only be decrypted into memory when the OmniGateway is actively routing a request. Removing a key via the TUI must instantly purge it from the SQLite database.  
* **US5: Virtual Colleague Multiplexing**  
  *As the OmniGateway, I must pool and multiplex keys from multiple virtual colleagues to bypass strict IP/account limits.*  
  **Acceptance Criteria:** If Provider A Key 1 hits 95% of its daily quota, the system must seamlessly rotate to Provider A Key 2 for the very next request without dropping the connection.

## **4\. Telemetry & Data Payloads (Deep Dive)**

To enable the Holo-CRT Watchtower to render 3D elements dynamically, the backend must interleave telemetry chunks within standard Server-Sent Events (SSE).

### **4.1 SSE Telemetry Chunk Schema**

The OmniGateway will inject custom aigency\_telemetry objects into the standard OpenAI chunk stream. The Holo-CRT frontend will intercept these without passing them back to the calling CLI agent.

{  
  "id": "chatcmpl-aigency-v5-891",  
  "object": "chat.completion.chunk",  
  "created": 1715068800,  
  "model": "aigency-auto",  
  "choices": \[{"delta": {"content": ""}, "index": 0, "finish\_reason": null}\],  
  "aigency\_telemetry": {  
    "event\_type": "DRIFT\_HEALED",  
    "layer": "Engram",  
    "details": {  
      "original\_provider": "cerebras/llama-3.1-8b",  
      "healing\_provider": "groq/llama3-8b-8192",  
      "latency\_ms": 142  
    }  
  }  
}

## **5\. Error Handling & Retry Matrix**

System resilience dictates how the OmniGateway handles specific HTTP errors from upstream providers. Silent failures are prohibited; all errors must trigger a specific routing action and log to SugarDB.

| HTTP Code | Trigger Condition | OmniGateway Action | SugarDB Log Event |
| :---- | :---- | :---- | :---- |
| 429 (Rate Limit) | Key exhausted quota or hit RPM limit. | Instant Failover. Rotate to the next key in the Canonical Array pool. Apply 5-minute cooldown to the failed key. | QUOTA\_EXHAUSTED |
| 403 (Forbidden) | API key revoked or IP banned. | Instant Failover. Permanently disable key in SugarVault runtime cache. Flag in TUI. | KEY\_REVOKED |
| 500/503 (Server Error) | Upstream provider is down. | Instant Failover to secondary provider in Canonical Array (e.g., from Groq to Cerebras). | PROVIDER\_DOWN |
| Judge Rejection | Engram DAG output fails validation. | Re-trigger the Swarm DAG. Max retries \= 3\. If it fails 3 times, abort and return partial to agent. | JUDGE\_REJECTION |

## **6\. Non-Functional Requirements (NFRs)**

* **Latency:** The "Fast Track" pathway (Layer 1 Governance \-\> Layer 3 OmniGateway) must introduce no more than **150ms** of overhead before connecting to the upstream provider.  
* **Security:** The SugarVault SQLite database must be encrypted using **AES-256-GCM**. The master decryption key is provided via a secure TUI prompt on application startup and is never stored on disk.  
* **Scalability:** The OmniGateway must support multiplexing up to **100 distinct API keys** simultaneously without memory degradation.  
* **UI Performance:** The Holo-CRT React/Three.js dashboard must maintain **60 FPS** while processing up to 50 concurrent SSE telemetry chunks per second.