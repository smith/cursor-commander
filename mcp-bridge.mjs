import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PORTS_DIR = join(homedir(), '.cursor-commander-ports');
const LEGACY_PORT_FILE = join(homedir(), '.cursor-commander-port');

function sanitizeWorkspacePath(fsPath) {
	return fsPath.replace(/^\//, '').replace(/\//g, '-');
}

function getPort() {
	const cwd = process.cwd();
	const key = sanitizeWorkspacePath(cwd);
	const candidates = [
		join(PORTS_DIR, key),
		join(PORTS_DIR, '_default'),
		LEGACY_PORT_FILE,
	];
	for (const candidate of candidates) {
		try {
			return parseInt(readFileSync(candidate, 'utf-8').trim(), 10);
		} catch {
			continue;
		}
	}
	throw new Error(
		`Cursor Commander extension is not running for workspace ${cwd}. ` +
		'Install the .vsix and restart Cursor.'
	);
}

async function sendCommand(command, args = {}) {
	const port = getPort();
	const res = await fetch(`http://127.0.0.1:${port}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ command, args }),
	});
	const data = await res.json();
	if (!data.success) { throw new Error(data.error); }
	return data.result;
}

const TOOLS = [
	{
		name: 'save_all_files',
		description: 'Save all open files in the editor',
		inputSchema: { type: 'object', properties: {} },
		handler: () => sendCommand('saveAll'),
	},
	{
		name: 'close_all_editors',
		description: 'Close all open editor tabs',
		inputSchema: { type: 'object', properties: {} },
		handler: () => sendCommand('closeAllEditors'),
	},
	{
		name: 'close_active_editor',
		description: 'Close the currently active editor tab',
		inputSchema: { type: 'object', properties: {} },
		handler: () => sendCommand('closeActiveEditor'),
	},
	{
		name: 'open_file',
		description: 'Open a file in the editor by absolute path',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Absolute path to the file' },
			},
			required: ['path'],
		},
		handler: (args) => sendCommand('openFile', { path: args.path }),
	},
	{
		name: 'get_open_files',
		description: 'List all files currently open in editor tabs',
		inputSchema: { type: 'object', properties: {} },
		handler: () => sendCommand('getOpenFiles'),
	},
	{
		name: 'show_message',
		description: 'Show an information message notification in the editor',
		inputSchema: {
			type: 'object',
			properties: {
				message: { type: 'string', description: 'Message to display' },
			},
			required: ['message'],
		},
		handler: (args) => sendCommand('showMessage', { message: args.message }),
	},
	{
		name: 'execute_command',
		description:
			'Execute any VS Code/Cursor command by ID ' +
			'(e.g. "editor.action.formatDocument", "workbench.action.toggleSidebarVisibility")',
		inputSchema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The VS Code command ID' },
				args: {
					type: 'array',
					description: 'Optional arguments for the command',
					items: {},
				},
			},
			required: ['command'],
		},
		handler: (args) =>
			sendCommand('executeCommand', {
				command: args.command,
				args: args.args,
			}),
	},
	{
		name: 'list_terminals',
		description:
			'List all open integrated terminals with their name, index, active status, and process ID',
		inputSchema: { type: 'object', properties: {} },
		handler: () => sendCommand('listTerminals'),
	},
	{
		name: 'create_terminal',
		description: 'Create a new integrated terminal',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Display name for the terminal' },
				cwd: { type: 'string', description: 'Initial working directory' },
				shellPath: {
					type: 'string',
					description: 'Path to the shell executable (e.g. /bin/zsh)',
				},
				env: {
					type: 'object',
					description: 'Environment variables to set',
					additionalProperties: { type: 'string' },
				},
				show: {
					type: 'boolean',
					description: 'Whether to show the terminal after creation (default true)',
				},
			},
		},
		handler: (args) => sendCommand('createTerminal', args),
	},
	{
		name: 'send_terminal_text',
		description:
			'Send text to an integrated terminal. Identify the target by name or index; omit both to use the active terminal.',
		inputSchema: {
			type: 'object',
			properties: {
				text: { type: 'string', description: 'Text to send to the terminal' },
				name: {
					type: 'string',
					description: 'Name of the target terminal',
				},
				index: {
					type: 'number',
					description: 'Index of the target terminal (from list_terminals)',
				},
				addNewLine: {
					type: 'boolean',
					description: 'Whether to append a newline (default true)',
				},
			},
			required: ['text'],
		},
		handler: (args) => sendCommand('sendTerminalText', args),
	},
	{
		name: 'show_terminal',
		description:
			'Show/focus an integrated terminal. Identify by name or index; omit both to use the active terminal.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Name of the terminal' },
				index: {
					type: 'number',
					description: 'Index of the terminal (from list_terminals)',
				},
				preserveFocus: {
					type: 'boolean',
					description:
						'If true, the terminal will not take focus (default true)',
				},
			},
		},
		handler: (args) => sendCommand('showTerminal', args),
	},
	{
		name: 'close_terminal',
		description:
			'Close/dispose an integrated terminal. Identify by name or index; omit both to close the active terminal.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Name of the terminal' },
				index: {
					type: 'number',
					description: 'Index of the terminal (from list_terminals)',
				},
			},
		},
		handler: (args) => sendCommand('closeTerminal', args),
	},
];

const server = new Server(
	{ name: 'cursor-commander', version: '0.1.0' },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: TOOLS.map(({ handler, ...rest }) => rest),
}));

let activeToolCalls = 0;

async function sendStatusUpdate(status) {
	try {
		const port = getPort();
		await fetch(`http://127.0.0.1:${port}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ command: 'setAgentStatus', args: { status } }),
		});
	} catch {
		// best-effort — extension may not be reachable
	}
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
	activeToolCalls++;
	if (activeToolCalls === 1) { await sendStatusUpdate('thinking'); }

	try {
		const { name, arguments: args } = request.params;
		const tool = TOOLS.find((t) => t.name === name);
		if (!tool) {
			return {
				content: [{ type: 'text', text: `Unknown tool: ${name}` }],
				isError: true,
			};
		}
		try {
			const result = await tool.handler(args || {});
			const text =
				result == null ? 'OK' :
				typeof result === 'string' ? result : JSON.stringify(result, null, 2);
			return { content: [{ type: 'text', text }] };
		} catch (err) {
			return {
				content: [{ type: 'text', text: `Error: ${err.message}` }],
				isError: true,
			};
		}
	} finally {
		activeToolCalls--;
		if (activeToolCalls === 0) { await sendStatusUpdate('idle'); }
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
