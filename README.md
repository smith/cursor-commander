# Cursor Commander

> **This is a personal throwaway project. Not published to the VS Code marketplace or npm. Not intended for general consumption. Use at your own risk.**

Exposes VS Code/Cursor editor commands as MCP tools so your AI agent can control the editor — save files, close tabs, open files, etc.

## Architecture

Two parts:

1. **VS Code extension** — runs inside Cursor, starts an HTTP server on a random local port
2. **MCP bridge** — standalone Node.js script spawned by Cursor's MCP system, forwards tool calls to the extension

## Setup

```bash
npm install
npm run compile
npm run package
```

Then install the generated `.vsix` file in Cursor:
- Open Command Palette (Cmd+Shift+P)
- Run "Extensions: Install from VSIX..."
- Select `cursor-commander-0.1.0.vsix`
- Reload Cursor

The MCP server is already configured in `~/.cursor/mcp.json`.

## Available tools

| Tool | Description |
|------|-------------|
| `save_all_files` | Save all open files |
| `close_all_editors` | Close all editor tabs |
| `close_active_editor` | Close the active tab |
| `open_file` | Open a file by path |
| `get_open_files` | List open files |
| `show_message` | Show a notification |
| `execute_command` | Run any VS Code command by ID |
