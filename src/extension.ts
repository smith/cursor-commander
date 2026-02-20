import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PORT_FILE = path.join(os.homedir(), '.cursor-commander-port');

let server: http.Server | undefined;

export function activate(context: vscode.ExtensionContext) {
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
		fs.writeFileSync(PORT_FILE, String(addr.port));
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
			return await vscode.commands.executeCommand(args.command, ...cmdArgs);
		}

		default:
			throw new Error(`Unknown command: ${command}`);
	}
}

function cleanup() {
	server?.close();
	try { fs.unlinkSync(PORT_FILE); } catch {}
}

export function deactivate() {
	cleanup();
}
