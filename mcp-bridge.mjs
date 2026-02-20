import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const PORT_FILE = join(homedir(), '.cursor-commander-port');

function getPort() {
	try {
		return parseInt(readFileSync(PORT_FILE, 'utf-8').trim(), 10);
	} catch {
		throw new Error(
			'Cursor Commander extension is not running. ' +
			'Install the .vsix and restart Cursor.'
		);
	}
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
];

const server = new Server(
	{ name: 'cursor-commander', version: '0.1.0' },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: TOOLS.map(({ handler, ...rest }) => rest),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
			typeof result === 'string' ? result : JSON.stringify(result, null, 2);
		return { content: [{ type: 'text', text }] };
	} catch (err) {
		return {
			content: [{ type: 'text', text: `Error: ${err.message}` }],
			isError: true,
		};
	}
});

const transport = new StdioServerTransport();
await server.connect(transport);
