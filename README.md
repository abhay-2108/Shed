# Shed

*A local, internet-accessible task plane for desktop coding agents.*  
*Powered by Laya.* MIT licensed.

**Website:** https://shed-sigma.vercel.app  
▶ [Watch the 80-second tour](https://shed-sigma.vercel.app/#tour) · [Download the video (MP4)](https://shed-sigma.vercel.app/shed-tour.mp4)

---

Shed gives you a central command center and mobile-accessible interface for the AI coding agents running on your machine. It shows sessions currently open across **Codex**, **Claude Code**, **Gemini CLI**, **Pi**, and **OpenCode**, streams their transcripts in real time, and lets you continue them or launch new workspaces from your phone or any browser.

---

## Quick Start

### Windows

Requirements: Node.js 20+ and PowerShell.

1. **Clone and install dependencies:**
   ```powershell
   git clone https://github.com/IAmUnbounded/shed.git
   cd shed
   npm install
   ```

2. **Start Shed:**
   ```powershell
   .\start.ps1
   ```
   *Shed starts the server on `http://localhost:4378` and initializes your secure remote tunnel (Cloudflare or Ngrok).*

3. **(Optional) Configure a permanent Ngrok domain:**
   ```powershell
   .\setup-ngrok.ps1
   ```

---

### macOS

Requirements: Node.js 20+, macOS 13+.

1. **One-line installer:**
   ```bash
   curl -fsSL https://shed-sigma.vercel.app/install.sh | sh
   ```
   *Clones Shed into `~/.shed/app`, configures background launch agents, and opens your browser.*

2. **Or run manually from source:**
   ```bash
   npm install
   npm start
   ```

3. **To uninstall on macOS:**
   ```bash
   curl -fsSL https://shed-sigma.vercel.app/install.sh | sh -s -- --uninstall
   ```

---

## First-Time Setup

1. **Set your password:** Open `http://localhost:4378` on your desktop and choose **Set a password for the first time**.
2. **Connect from your phone:**
   - Scan the on-screen QR code with your phone camera, or
   - Open the secure HTTPS link shown under **Settings → Phone access** and sign in with your password.
3. **Approve your phone:**
   - On the desktop, click **Approve** next to your new device under **Settings → Devices**.
   - *Tip:* You can also enable **"Automatically approve remote devices that enter the correct password"** in Settings for seamless pairing when away from your computer.
4. **Add to Home Screen:** For the native app experience and instant background notifications, add Shed to your phone's Home Screen from the browser Share menu.

---

## Features

### 1. Local Laya Routing Engine
* Shed routes prompts using the open-source [Laya decision model](https://github.com/NandhaKishorM/laya) through the [`@receptron/laya`](https://github.com/receptron/laya) ONNX runtime.
* Runs 100% locally on your machine—no cloud API keys or third-party accounts required.
* Automatically selects the best harness and model for new tasks, while preserving context on follow-up turns.

### 2. Multi-Harness Support
Connects directly to your installed agent CLIs and session histories:

| Harness | Session Discovery | Task Execution | Resume Capability |
| :--- | :--- | :--- | :--- |
| **Codex** | `~/.codex/sessions` | `codex` CLI | `codex exec resume` / `codex queue` |
| **Claude Code** | `~/.claude/projects` | `claude` CLI | `claude --resume` |
| **Gemini** | `~/.gemini/tmp/*/chats` | `gemini` CLI | `gemini --resume` |
| **Pi** | `~/.pi/agent/sessions` | `pi` CLI | `pi --session` |
| **OpenCode** | Session list & local server API | `opencode` CLI | `opencode run --session` |

### 3. Projects & Workspaces Browser
* Visual directory explorer showing all repositories and workspaces on your machine.
* Tracks git branch state, active live sessions, and recent conversations.
* Search and filter by name, branch, path, or activity with one-click new session creation.

### 4. Interactive Mobile & Web Experience
* **Live Agent Desk:** Follow running agents and check their thinking state in real time.
* **Terminal Tab:** View the actual agent CLI terminal output and reply to interactive prompts (confirmations, permissions, multi-choice questions) right from your phone.
* **Responsive Layout:** Clean, touch-optimized UI engineered for both desktop monitors and ultra-compact mobile viewports.
* **File Drawer:** Inspect, preview, and download images, PDFs, code outputs, and generated artifacts directly from the session folder.

### 5. Web Push Notifications
* Receive instant notifications on your phone or laptop when an agent completes a task or requests your permission.
* Works even when Shed is closed in your browser.

---

## Security & Privacy

* **Zero external telemetry:** Prompts, session logs, code files, and model decisions never leave your desktop.
* **Authenticated remote access:** Only approved devices with the correct password can connect over TLS/HTTPS.
* **Blast-radius containment:** File inspection and downloads are strictly sandboxed to active project directories; sensitive paths, hidden directories, and system files cannot be served.
* **Strict CSP & Headers:** Hardened with `X-Frame-Options: DENY`, strict Content Security Policy, and zero-referrer leakage.

---

## Development & Testing

Run the test suite:

```bash
npm test
```

Unit and integration tests verify Laya model routing, terminal session control, upload validation, path security, and approval mechanics without requiring external services.
