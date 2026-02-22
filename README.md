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

## Agent status indicator

A green dot in the status bar shows whether the agent is active:

- **Flashing green dot** — agent is actively making tool calls
- **Solid green dot** — agent is idle, waiting for you

The extension detects activity automatically by tracking HTTP requests from the MCP bridge. When a tool call comes in, the dot starts flashing. After 8 seconds of silence, it settles to solid. No configuration needed — it activates on the first tool call in a session.

The `setAgentStatus` command is still available as a manual override.

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
| `list_terminals` | List all open integrated terminals |
| `create_terminal` | Create a new terminal (optional name, cwd, env) |
| `send_terminal_text` | Send text/commands to a terminal |
| `show_terminal` | Show/focus a terminal |
| `close_terminal` | Close a terminal |
