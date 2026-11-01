# CodeHarbor

CodeHarbor is a local browser-based development environment powered by code-server (VS Code in the browser). It provides a full IDE experience with real extension support, integrated terminal, Git integration, and persistent workspaces — all running locally on your Windows machine.

## Features

- Full VS Code editing experience (syntax highlighting, IntelliSense, minimap, multi-cursor)
- Real extension support via the Open VSX marketplace — install, enable, disable, uninstall
- Integrated terminal with PowerShell (PTY-based, not simulated)
- Git integration (status, diff, commit, branch management)
- File explorer with full workspace operations
- Search across files
- Settings, keybindings, and theme customization
- Run and debug support
- Command palette (Ctrl+Shift+P)

## Start

1. Run `Install-CodeHarbor.ps1` once to install Node.js dependencies.
2. Run `Start-CodeHarbor.ps1`. It launches the server and opens `http://127.0.0.1:4170` in your browser.
3. Use the IDE. Files are stored in the `workspace/` directory and persist on disk.
4. Run `Stop-CodeHarbor.ps1` to stop the server.

## Architecture

CodeHarbor runs two processes:
- **Node.js proxy** (port 4170) — the entry point, handles routing and WebSocket proxying
- **code-server** (port 4171, internal) — the full VS Code runtime with extension host, terminal, and file system access

Both bind to `127.0.0.1` only. This is a single-user local tool and should not be exposed to a network.

## Extensions

Extensions are installed from the Open VSX marketplace. Use the Extensions sidebar (Ctrl+Shift+X) to search, install, and manage extensions. Installed extensions persist in `.runtime/extensions/` between sessions.

## Requirements

- Windows 10/11
- Node.js 20 or newer on PATH
