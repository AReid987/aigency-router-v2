# Story 4.2: xterm.js Web Bridge

**Overview Description:** Expose the Textual TUI over a lightweight web server to allow remote management on cloud instances without requiring SSH access.

**Complexity Score:** 5

**Dependencies:** Story 4.1

**Developer Guidance:** Utilize `xterm.js` on the frontend and `node-pty` (or a Python equivalent like `ptyprocess`) on the backend, bridging them with WebSockets. Secure this route heavily.

### Checkbox Tasklist:
* [ ] Setup WebSockets server on port 8080.
* [ ] Spawn the Textual TUI process inside a PTY.
* [ ] Pipe PTY I/O to WebSockets and render via xterm.js in the browser.

### Acceptance Criteria:
* Navigating to `localhost:8080` renders a fully interactive terminal running the Voltron TUI in the browser.

### Resource URLs:
* Xterm.js: [https://xtermjs.org/](https://xtermjs.org/)
