# **Aigency OS (Voltron Release): Comprehensive Architecture Specification**

**Date:** May 7, 2026  
**Version:** 5.0.0 (Voltron Core)  
**Target Context:** Autonomous Agent Swarm Orchestration

## **1\. System Topology & Core Boundaries**

The Voltron architecture is a hybrid, polyglot monorepo strictly isolating heavy ML tensor operations from high-I/O asynchronous network routing. This separation of concerns allows the 1-bit quantized SLMs to evaluate heuristics locally without blocking the Node.js event loop responsible for multiplexing outbound HTTP requests.

* **Layer 0 (Client):** Local or distributed autonomous CLI agents utilizing canonical model strings (e.g., llama3, claude-3-opus).  
* **Layer 1 (Governance):** Python 3.12+ runtime. FastAPI intercepts the standard OpenAI /v1/chat/completions schema. vLLM loads BitNet b1.58 for zero-latency prompt evaluation.  
* **Layer 2 & 3 (Middleware & Egress):** Node.js / TypeScript runtime. The Engram engine orchestrates DAG swarms and auto-heals JSON. The ModelTranslator resolves canonical strings. The OmniGateway executes the multiplexed routing using CLIProxyAPI logic.  
* **Layer 4 (Memory):** Two localized SQLite databases. **SugarVault** stores AES-256 encrypted API keys. **SugarDB** stores operational telemetry.  
* **Layer 5 (Control & Observability):** A Textual/Typer Python TUI exposed via xterm.js for configuration, and a React/Three.js web dashboard for visual telemetry consumption via Server-Sent Events (SSE).

## **2\. API Contracts & Payload Boundaries**

Strict schema adherence between the Python and TypeScript layers is mandatory to prevent silent failures in the routing pipeline.

### **2.1 Python (Layer 1\) to Node.js (Layer 2\) Internal Forwarding**

When the Python brain classifies a prompt as "Simple", it forwards the payload to the Node.js OmniGateway port, appending custom Aigency metadata.

POST http://localhost:3000/v1/internal/route  
Content-Type: application/json

{  
  "model": "llama3",  
  "messages": \[{"role": "user", "content": "Write a python script..."}\],  
  "temperature": 0.7,  
  "stream": true,  
  "aigency\_metadata": {  
    "orchestration\_mode": "fast",  
    "enforce\_json\_schema": false,  
    "source\_agent": "OpenClaw-CLI"  
  }  
}

### **2.2 Node.js (Layer 3\) to Python (Layer 1\) SSE Stream Return**

The TypeScript layer streams standard OpenAI chunks back to Python, but embeds a distinct aigency\_telemetry block required by the Holo-CRT UI.

data: {  
  "id": "chatcmpl-aigency-v5-892",  
  "object": "chat.completion.chunk",  
  "choices": \[{"delta": {"content": "import sys\\n"}}\],  
  "aigency\_telemetry": {  
    "status": "ACTIVE",  
    "provider\_node": "groq/llama3-8b-8192",  
    "multiplex\_pool\_id": "vc\_alpha\_01"  
  }  
}

## **3\. Database Schemas (Layer 4\)**

Data sovereignty is maintained via local SQLite. Vector databases are completely removed from this architecture.

### **3.1 SugarVault (Encrypted Credentials)**

This table is strictly encrypted at rest via AES-256-GCM. The decryption key exists only in volatile memory during runtime.

| Column Name | Data Type | Description / Constraints |
| :---- | :---- | :---- |
| id | UUID | Primary Key. |
| provider\_id | TEXT | E.g., groq, cerebras, together. |
| api\_key\_encrypted | BLOB | The AES-256-GCM ciphertext of the API key. |
| virtual\_colleague\_id | TEXT | Identifier for the key pool (Multiplexing ID). |
| is\_active | BOOLEAN | Toggled via the TUI to instantly halt usage. |

### **3.2 SugarDB (Telemetry & Diagnostics)**

| Column Name | Data Type | Description / Constraints |
| :---- | :---- | :---- |
| log\_id | INTEGER | Auto-incrementing Primary Key. |
| timestamp | DATETIME | Execution time of the recorded event. |
| event\_class | TEXT | E.g., QUOTA\_WARNING, DRIFT\_HEALED, JUDGE\_REJECT. |
| payload\_snapshot | JSON | The exact prompt or broken JSON that caused the event (critical for fine-tuning). |

## **4\. Network & Port Configuration**

The polyglot environment requires strict internal port mapping to avoid collisions and expose the correct endpoints to the client tools.

| Service Component | Internal Port | Exposure / Access |
| :---- | :---- | :---- |
| FastAPI (Layer 1 Ingress) | 8000 | Exposed to localhost network. CLI agents point here. |
| OmniGateway (Node.js Egress) | 3000 | Internal network only. Accessible only by FastAPI. |
| Holo-CRT Dashboard (React) | 5173 | Exposed to localhost browser. Consumes port 8000 SSE. |
| TUI Web Bridge (xterm.js) | 8080 | Optional exposure for remote SSH-less administration. |

