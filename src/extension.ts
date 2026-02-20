import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PORTS_DIR = path.join(os.homedir(), '.cursor-commander-ports');

function sanitizeWorkspacePath(fsPath: string): string {
	return fsPath.replace(/^\//, '').replace(/\//g, '-');
}

function getWorkspaceKey(): string | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) { return undefined; }
	return sanitizeWorkspacePath(folders[0].uri.fsPath);
}

function getPortFilePath(): string {
	const key = getWorkspaceKey();
	if (key) {
		return path.join(PORTS_DIR, key);
	}
	return path.join(PORTS_DIR, '_default');
}

let server: http.Server | undefined;
let portFilePath: string | undefined;
let agentStatusItem: vscode.StatusBarItem;
let agentStatusTimeout: ReturnType<typeof setTimeout> | undefined;

export function activate(context: vscode.ExtensionContext) {
	agentStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	agentStatusItem.name = 'Agent Status';
	context.subscriptions.push(agentStatusItem);

	server = http.createServer(async (req, res) => {
		if (req.method !== 'POST') {
			res.writeHead(405);
			res.end();
			return;
		}

		let body = '';
		req.on('data', (chunk: string) => body += chunk);
		req.on('end', async () => {
			try {
				const { command, args } = JSON.parse(body);
				const result = await handleCommand(command, args || {});
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ success: true, result }));
			} catch (err: any) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ success: false, error: err.message }));
			}
		});
	});

	server.listen(0, '127.0.0.1', () => {
		const addr = server!.address() as { port: number };
		portFilePath = getPortFilePath();
		fs.mkdirSync(PORTS_DIR, { recursive: true });
		fs.writeFileSync(portFilePath, String(addr.port));
		vscode.window.setStatusBarMessage(`Cursor Commander: port ${addr.port}`, 5000);
	});

	context.subscriptions.push(
		{ dispose: () => cleanup() },
		vscode.commands.registerCommand('cursorCommander.showPort', () => {
			const addr = server?.address();
			if (addr && typeof addr === 'object') {
				vscode.window.showInformationMessage(`Cursor Commander on port ${addr.port}`);
			} else {
				vscode.window.showWarningMessage('Cursor Commander server not running');
			}
		})
	);
}

function findTerminal(args: { name?: string; index?: number }): vscode.Terminal {
	const terminals = vscode.window.terminals;
	if (args.name !== undefined) {
		const t = terminals.find(t => t.name === args.name);
		if (!t) { throw new Error(`No terminal named "${args.name}"`); }
		return t;
	}
	if (args.index !== undefined) {
		if (args.index < 0 || args.index >= terminals.length) {
			throw new Error(`Terminal index ${args.index} out of range (0-${terminals.length - 1})`);
		}
		return terminals[args.index];
	}
	const active = vscode.window.activeTerminal;
	if (!active) { throw new Error('No active terminal'); }
	return active;
}

async function handleCommand(command: string, args: any): Promise<any> {
	switch (command) {
		case 'saveAll':
			await vscode.commands.executeCommand('workbench.action.files.saveAll');
			return 'All files saved';

		case 'closeAllEditors':
			await vscode.commands.executeCommand('workbench.action.closeAllEditors');
			return 'All editors closed';

		case 'closeActiveEditor':
			await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
			return 'Active editor closed';

		case 'openFile': {
			const uri = vscode.Uri.file(args.path);
			await vscode.commands.executeCommand('vscode.open', uri);
			return `Opened ${args.path}`;
		}

		case 'getOpenFiles': {
			const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
			return tabs
				.map(t => (t.input as any)?.uri?.fsPath)
				.filter(Boolean);
		}

		case 'showMessage':
			await vscode.window.showInformationMessage(args.message);
			return 'Message shown';

		case 'executeCommand': {
			const cmdArgs = args.args || [];
			const result = await vscode.commands.executeCommand(args.command, ...cmdArgs);
			return result ?? `Executed ${args.command}`;
		}

		case 'listTerminals': {
			const terminals = vscode.window.terminals;
			const active = vscode.window.activeTerminal;
			return Promise.all(terminals.map(async (t, i) => ({
				index: i,
				name: t.name,
				isActive: t === active,
				processId: await t.processId,
			})));
		}

		case 'createTerminal': {
			const options: vscode.TerminalOptions = {};
			if (args.name) { options.name = args.name; }
			if (args.cwd) { options.cwd = args.cwd; }
			if (args.shellPath) { options.shellPath = args.shellPath; }
			if (args.env) { options.env = args.env; }
			const terminal = vscode.window.createTerminal(options);
			if (args.show !== false) { terminal.show(true); }
			return {
				name: terminal.name,
				index: vscode.window.terminals.indexOf(terminal),
			};
		}

		case 'sendTerminalText': {
			const terminal = findTerminal(args);
			terminal.sendText(args.text, args.addNewLine !== false);
			return `Sent text to terminal "${terminal.name}"`;
		}

		case 'closeTerminal': {
			const terminal = findTerminal(args);
			const name = terminal.name;
			terminal.dispose();
			return `Closed terminal "${name}"`;
		}

		case 'showTerminal': {
			const terminal = findTerminal(args);
			terminal.show(args.preserveFocus ?? true);
			return `Showing terminal "${terminal.name}"`;
		}

		case 'setAgentStatus': {
			if (agentStatusTimeout) { clearTimeout(agentStatusTimeout); }
			if (args.status === 'thinking') {
				agentStatusItem.text = '$(loading~spin)';
				agentStatusItem.tooltip = 'Agent is working...';
				agentStatusItem.color = undefined;
				agentStatusItem.show();
				agentStatusTimeout = setTimeout(() => agentStatusItem.hide(), 10 * 60 * 1000);
			} else if (args.status === 'idle') {
				agentStatusItem.text = '$(circle-filled)';
				agentStatusItem.tooltip = 'Waiting for you';
				agentStatusItem.color = new vscode.ThemeColor('testing.iconPassed');
				agentStatusItem.show();
				agentStatusTimeout = setTimeout(() => agentStatusItem.hide(), 3 * 60 * 1000);
			} else {
				agentStatusItem.hide();
			}
			return `Agent status: ${args.status}`;
		}

		default:
			throw new Error(`Unknown command: ${command}`);
	}
}

function cleanup() {
	if (agentStatusTimeout) { clearTimeout(agentStatusTimeout); }
	server?.close();
	if (portFilePath) {
		try { fs.unlinkSync(portFilePath); } catch {}
	}
}

export function deactivate() {
	cleanup();
}
