import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PORTS_DIR = path.join(os.homedir(), '.cursor-commander-ports');
const IDLE_AFTER_MS = 8000;

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
let flashInterval: ReturnType<typeof setInterval> | undefined;
let flashOn = true;

// Agent activity detection via HTTP request tracking
let lastRequestTime = 0;
let activityPollInterval: ReturnType<typeof setInterval> | undefined;
let currentStatus: 'thinking' | 'idle' | 'hidden' = 'hidden';

function startFlash() {
	if (flashInterval) { return; }
	flashOn = true;
	agentStatusItem.text = '$(circle-filled)';
	flashInterval = setInterval(() => {
		flashOn = !flashOn;
		agentStatusItem.text = flashOn ? '$(circle-filled)' : '$(circle-outline)';
	}, 600);
}

function stopFlash() {
	if (flashInterval) { clearInterval(flashInterval); flashInterval = undefined; }
	agentStatusItem.text = '$(circle-filled)';
}

function setAgentStatusDisplay(status: 'thinking' | 'idle' | 'hidden') {
	if (status === currentStatus) { return; }
	currentStatus = status;
	const green = new vscode.ThemeColor('testing.iconPassed');
	if (status === 'thinking') {
		agentStatusItem.tooltip = 'Agent is working...';
		agentStatusItem.color = green;
		agentStatusItem.show();
		startFlash();
	} else if (status === 'idle') {
		stopFlash();
		agentStatusItem.tooltip = 'Waiting for you';
		agentStatusItem.color = green;
		agentStatusItem.show();
	} else {
		stopFlash();
		agentStatusItem.hide();
	}
}

function onRequestActivity() {
	lastRequestTime = Date.now();
	setAgentStatusDisplay('thinking');
}

function startActivityPolling() {
	activityPollInterval = setInterval(() => {
		if (lastRequestTime === 0) { return; }
		if (currentStatus === 'thinking' && Date.now() - lastRequestTime >= IDLE_AFTER_MS) {
			setAgentStatusDisplay('idle');
		}
	}, 1000);
}

export function activate(context: vscode.ExtensionContext) {
	agentStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	agentStatusItem.name = 'Agent Status';
	context.subscriptions.push(agentStatusItem);

	startActivityPolling();

	server = http.createServer(async (req, res) => {
		if (req.method !== 'POST') {
			res.writeHead(405);
			res.end();
			return;
		}

		onRequestActivity();

		let body = '';
		req.on('data', (chunk: string) => body += chunk);
		req.on('end', async () => {
			try {
				const { command, args } = JSON.parse(body);
				const result = await handleCommand(command, args || {});
				onRequestActivity();
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
			if (args.status === 'thinking') {
				setAgentStatusDisplay('thinking');
			} else if (args.status === 'idle') {
				setAgentStatusDisplay('idle');
			} else {
				setAgentStatusDisplay('hidden');
			}
			return `Agent status: ${args.status}`;
		}

		default:
			throw new Error(`Unknown command: ${command}`);
	}
}

function cleanup() {
	stopFlash();
	if (activityPollInterval) { clearInterval(activityPollInterval); }
	server?.close();
	if (portFilePath) {
		try { fs.unlinkSync(portFilePath); } catch {}
	}
}

export function deactivate() {
	cleanup();
}
