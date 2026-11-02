# CodeHarbor

A complete browser-based coding environment with a real editor, terminal, preview, and an AI assistant that edits your files for you.
<img width="1600" height="814" alt="{9F4A910D-77D7-4357-9B42-D7CD684C16E3}" src="https://github.com/user-attachments/assets/5f22ed0c-175a-499d-a471-1d978c50e8cf" />

[Live Website](https://codeharbor-theta.vercel.app/) · [GitHub Repository](https://github.com/rengoku210/CodeHarbor)

CodeHarbor is a browser IDE built to feel like a desktop development tool. You can open a project, write HTML/CSS/JavaScript with real coding assistance, run it, preview it, fix problems with AI, and manage your changes with Git all from one tab, without installing an IDE.

# Goals
1. Let developers open a workspace and start writing code immediately.

2. Make running and previewing projects one click away.

3. Use AI that actually edits your files instead of just talking about code.

# Features
1. Explorer: Create, rename, delete, and copy paths for files and folders with right-click menus.

2. Editor: Real Monaco editor with tabs, dirty-state indicators, keyboard shortcuts (Ctrl+S, Ctrl+P, Ctrl+J, Ctrl+G, F8).

3. Quick Open: Press Ctrl+P and fuzzy-search project files, navigate with arrows, and open from the keyboard.

4. IntelliSense: HTML, CSS, and JavaScript suggestions. Type `!` and press Tab for a full HTML5 boilerplate. HTML tags auto-close.

5. Go & Selection menus: Go to line/file/symbol/definition, next/previous problem, expand selection, add cursors above/below.

6. Run: A green Run button detects what you're working on HTML opens a live Preview panel, CSS finds its HTML entry, JS runs via Node or `npm run dev/start/serve`.

7. Preview: Refresh, open in a new tab, close, and auto-reload when you save the file you're previewing.

8. Terminal: A persistent PowerShell terminal connected to the workspace. Run npm, git, node, and normal commands with streaming output.

9. AI Assistant: Ask questions, fix the active file, or explain the last error. The AI reads your open file, patches it, saves it, and the editor updates instantly.

10. Source Control: Initialize a repo, see modified files, stage/unstage, view diffs, and commit all from the sidebar.

11. Extensions: Open the built-in code-server IDE (`/ide`) for the full VS Code-compatible experience with Open VSX marketplace extensions.

12. Workspace controls: Ctrl + mouse wheel zooms the whole UI (75–150%), Ctrl+0 resets. The AI panel can be docked left or right and resized.

<img width="1600" height="813" alt="{C07ED1BA-39BE-4D6B-9695-9870D1BAE38A}" src="https://github.com/user-attachments/assets/ec5bc783-d50e-4835-9a9b-30c2fc66cff7" />

# How to Use
Use It Online

No account or installation is required to try the hosted version.

Website: https://codeharbor-theta.vercel.app/

# Run It Locally
1. Clone the CodeHarbor repository.

2. Open the project folder.

3. Run `Install-CodeHarbor.ps1` once to install Node.js dependencies.

4. Run `Start-CodeHarbor.ps1` it starts the server and opens http://127.0.0.1:4170/ in your browser.

5. Run `Stop-CodeHarbor.ps1` when you want to stop it.

Files live in the `workspace/` folder and persist on disk between sessions.

# How It Works
CodeHarbor is two processes working together. A Node.js server (port 4170) serves the custom Monaco editor interface, the file and Git APIs, the AI agent, and the WebSocket terminal. A bundled code-server runtime (port 4171) powers the full VS Code-compatible IDE at `/ide` with real extension support. The AI assistant uses the Inception API (Mercury-3) and only touches files inside the workspace.

# AI Assistance
CodeHarbor was developed using AI coding tools, which generated most of the code. The core idea, features, functionality, UI/UX preferences, and product direction were defined by me. I personally tested the application, identified bugs, and directed improvements and fixes. AI assisted with implementation, while I led the product development.

# Credits and Acknowledgements
Created by: Rengoku (@rengoku210) for Hack Club.

Built with Node.js, Express, Monaco Editor, and open-source code-server.

