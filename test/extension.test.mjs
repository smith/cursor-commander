import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORTS_DIR = path.join(os.homedir(), '.cursor-commander-ports');
const TEST_WORKSPACE = '/Users/test/Code/my-project';
const TEST_PORT_KEY = 'Users-test-Code-my-project';
const TEST_PORT_FILE = path.join(PORTS_DIR, TEST_PORT_KEY);

// --- vscode mock ---

function createMockTerminal(name, processId = 1234) {
  return {
    name,
    processId: Promise.resolve(processId),
    sendText: mock.fn(),
    show: mock.fn(),
    hide: mock.fn(),
    dispose: mock.fn(),
  };
}

function createMockStatusBarItem() {
  return {
    text: '',
    tooltip: '',
    color: undefined,
    name: '',
    show: mock.fn(),
    hide: mock.fn(),
    dispose: mock.fn(),
  };
}

function createVscodeMock() {
  const executedCommands = [];
  const mockTabs = [];
  const mockTerminals = [];
  let mockActiveTerminal = undefined;
  let mockCreateTerminal = mock.fn((options) => {
    const t = createMockTerminal(options?.name || 'default');
    mockTerminals.push(t);
    return t;
  });
  const mockStatusBarItem = createMockStatusBarItem();

  return {
    executedCommands,
    mockTabs,
    mockTerminals,
    mockStatusBarItem,
    get mockActiveTerminal() { return mockActiveTerminal; },
    set mockActiveTerminal(v) { mockActiveTerminal = v; },
    mockCreateTerminal,
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    commands: {
      executeCommand: mock.fn(async (...args) => {
        executedCommands.push(args);
      }),
      registerCommand: mock.fn((id, cb) => ({ dispose: () => {} })),
    },
    window: {
      setStatusBarMessage: mock.fn(),
      showInformationMessage: mock.fn(async () => {}),
      showWarningMessage: mock.fn(async () => {}),
      createStatusBarItem: mock.fn(() => mockStatusBarItem),
      tabGroups: {
        get all() {
          return [{ tabs: mockTabs }];
        },
      },
      get terminals() { return mockTerminals; },
      get activeTerminal() { return mockActiveTerminal; },
      get createTerminal() { return mockCreateTerminal; },
    },
    workspace: {
      workspaceFolders: [
        { uri: { fsPath: TEST_WORKSPACE }, name: 'my-project', index: 0 },
      ],
    },
    Uri: {
      file: (p) => ({ fsPath: p, scheme: 'file' }),
    },
  };
}

// --- Helper to load extension with mocked vscode ---

async function loadExtension(vscodeMock) {
  const mod = await import('module');
  const require = mod.createRequire(import.meta.url);

  // Patch require to intercept 'vscode'
  const origResolveFilename = mod.Module._resolveFilename;
  mod.Module._resolveFilename = function (request, parent, ...rest) {
    if (request === 'vscode') return 'vscode';
    return origResolveFilename.call(this, request, parent, ...rest);
  };
  const origLoad = mod.Module._cache;

  // Inject vscode into the module cache
  const vscodeModule = new mod.Module('vscode');
  vscodeModule.exports = vscodeMock;
  vscodeModule.loaded = true;
  mod.Module._cache['vscode'] = vscodeModule;

  // Clear any cached version of extension.js
  const extensionPath = path.resolve(
    import.meta.dirname,
    '..',
    'out',
    'extension.js',
  );
  delete require.cache[extensionPath];

  const ext = require(extensionPath);

  return {
    ext,
    cleanup: () => {
      delete mod.Module._cache['vscode'];
      delete require.cache[extensionPath];
      mod.Module._resolveFilename = origResolveFilename;
    },
  };
}

// --- Helper to POST a command to the server ---

function postCommand(port, command, args = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ command, args });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function httpGet(port) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}`, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      })
      .on('error', reject);
  });
}

// --- Tests ---

describe('Extension HTTP Server', () => {
  let vscodeMock;
  let loaded;
  let port;

  beforeEach(async () => {
    vscodeMock = createVscodeMock();
    loaded = await loadExtension(vscodeMock);

    const subscriptions = [];
    const context = { subscriptions };
    loaded.ext.activate(context);

    // Wait for server to start and port file to be written
    await new Promise((resolve) => setTimeout(resolve, 200));
    const portStr = fs.readFileSync(TEST_PORT_FILE, 'utf-8').trim();
    port = parseInt(portStr, 10);
    assert.ok(port > 0, `Expected valid port, got ${portStr}`);
  });

  afterEach(async () => {
    loaded.ext.deactivate();
    loaded.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it('writes a workspace-scoped port file on activation', () => {
    assert.ok(fs.existsSync(TEST_PORT_FILE));
    const p = parseInt(fs.readFileSync(TEST_PORT_FILE, 'utf-8').trim(), 10);
    assert.equal(p, port);
  });

  it('rejects non-POST requests with 405', async () => {
    const res = await httpGet(port);
    assert.equal(res.status, 405);
  });

  it('handles saveAll command', async () => {
    const res = await postCommand(port, 'saveAll');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.result, 'All files saved');
    assert.ok(
      vscodeMock.executedCommands.some(
        (c) => c[0] === 'workbench.action.files.saveAll',
      ),
    );
  });

  it('handles closeAllEditors command', async () => {
    const res = await postCommand(port, 'closeAllEditors');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.result, 'All editors closed');
    assert.ok(
      vscodeMock.executedCommands.some(
        (c) => c[0] === 'workbench.action.closeAllEditors',
      ),
    );
  });

  it('handles closeActiveEditor command', async () => {
    const res = await postCommand(port, 'closeActiveEditor');
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'Active editor closed');
  });

  it('handles openFile command', async () => {
    const res = await postCommand(port, 'openFile', { path: '/tmp/test.txt' });
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'Opened /tmp/test.txt');
    assert.ok(
      vscodeMock.executedCommands.some(
        (c) => c[0] === 'vscode.open' && c[1]?.fsPath === '/tmp/test.txt',
      ),
    );
  });

  it('handles getOpenFiles command', async () => {
    vscodeMock.mockTabs.push(
      { input: { uri: { fsPath: '/a.txt' } } },
      { input: { uri: { fsPath: '/b.txt' } } },
    );
    const res = await postCommand(port, 'getOpenFiles');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.result, ['/a.txt', '/b.txt']);
  });

  it('handles getOpenFiles with empty tabs', async () => {
    const res = await postCommand(port, 'getOpenFiles');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.result, []);
  });

  it('handles showMessage command', async () => {
    const res = await postCommand(port, 'showMessage', {
      message: 'Hello!',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'Message shown');
    assert.equal(
      vscodeMock.window.showInformationMessage.mock.calls.length,
      1,
    );
  });

  it('handles executeCommand command', async () => {
    const res = await postCommand(port, 'executeCommand', {
      command: 'editor.action.formatDocument',
      args: ['arg1'],
    });
    assert.equal(res.status, 200);
    assert.ok(
      vscodeMock.executedCommands.some(
        (c) =>
          c[0] === 'editor.action.formatDocument' && c[1] === 'arg1',
      ),
    );
  });

  it('returns 500 for unknown commands', async () => {
    const res = await postCommand(port, 'nonexistent');
    assert.equal(res.status, 500);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /Unknown command/);
  });

  it('returns 500 for malformed JSON', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        },
      );
      req.on('error', reject);
      req.end('not json at all');
    });
    assert.equal(res.status, 500);
    assert.equal(res.body.success, false);
  });

  it('removes port file on deactivate', () => {
    loaded.ext.deactivate();
    assert.ok(!fs.existsSync(TEST_PORT_FILE));
  });

  // --- Terminal commands ---

  it('handles listTerminals with no terminals', async () => {
    const res = await postCommand(port, 'listTerminals');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.result, []);
  });

  it('handles listTerminals with terminals present', async () => {
    const t1 = createMockTerminal('zsh', 111);
    const t2 = createMockTerminal('node', 222);
    vscodeMock.mockTerminals.push(t1, t2);
    vscodeMock.mockActiveTerminal = t1;

    const res = await postCommand(port, 'listTerminals');
    assert.equal(res.status, 200);
    const result = res.body.result;
    assert.equal(result.length, 2);
    assert.equal(result[0].name, 'zsh');
    assert.equal(result[0].isActive, true);
    assert.equal(result[0].processId, 111);
    assert.equal(result[1].name, 'node');
    assert.equal(result[1].isActive, false);
    assert.equal(result[1].processId, 222);
  });

  it('handles createTerminal with name and cwd', async () => {
    const res = await postCommand(port, 'createTerminal', {
      name: 'my-term',
      cwd: '/tmp',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.name, 'my-term');
    assert.equal(vscodeMock.mockCreateTerminal.mock.calls.length, 1);
    const callArgs = vscodeMock.mockCreateTerminal.mock.calls[0].arguments[0];
    assert.equal(callArgs.name, 'my-term');
    assert.equal(callArgs.cwd, '/tmp');
  });

  it('handles sendTerminalText by index', async () => {
    const t = createMockTerminal('zsh');
    vscodeMock.mockTerminals.push(t);

    const res = await postCommand(port, 'sendTerminalText', {
      index: 0,
      text: 'echo hello',
    });
    assert.equal(res.status, 200);
    assert.match(res.body.result, /Sent text/);
    assert.equal(t.sendText.mock.calls.length, 1);
    assert.equal(t.sendText.mock.calls[0].arguments[0], 'echo hello');
  });

  it('handles sendTerminalText by name', async () => {
    const t = createMockTerminal('build');
    vscodeMock.mockTerminals.push(t);

    const res = await postCommand(port, 'sendTerminalText', {
      name: 'build',
      text: 'npm run build',
    });
    assert.equal(res.status, 200);
    assert.equal(t.sendText.mock.calls.length, 1);
    assert.equal(t.sendText.mock.calls[0].arguments[0], 'npm run build');
  });

  it('handles sendTerminalText using active terminal', async () => {
    const t = createMockTerminal('active-shell');
    vscodeMock.mockTerminals.push(t);
    vscodeMock.mockActiveTerminal = t;

    const res = await postCommand(port, 'sendTerminalText', { text: 'ls' });
    assert.equal(res.status, 200);
    assert.equal(t.sendText.mock.calls.length, 1);
  });

  it('returns error for sendTerminalText with no active terminal', async () => {
    const res = await postCommand(port, 'sendTerminalText', { text: 'ls' });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /No active terminal/);
  });

  it('returns error for sendTerminalText with bad index', async () => {
    const res = await postCommand(port, 'sendTerminalText', {
      index: 99,
      text: 'ls',
    });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /out of range/);
  });

  it('returns error for sendTerminalText with unknown name', async () => {
    const res = await postCommand(port, 'sendTerminalText', {
      name: 'nope',
      text: 'ls',
    });
    assert.equal(res.status, 500);
    assert.match(res.body.error, /No terminal named/);
  });

  it('handles showTerminal by index', async () => {
    const t = createMockTerminal('zsh');
    vscodeMock.mockTerminals.push(t);

    const res = await postCommand(port, 'showTerminal', { index: 0 });
    assert.equal(res.status, 200);
    assert.match(res.body.result, /Showing terminal/);
    assert.equal(t.show.mock.calls.length, 1);
  });

  it('handles closeTerminal by name', async () => {
    const t = createMockTerminal('disposable');
    vscodeMock.mockTerminals.push(t);

    const res = await postCommand(port, 'closeTerminal', { name: 'disposable' });
    assert.equal(res.status, 200);
    assert.match(res.body.result, /Closed terminal/);
    assert.equal(t.dispose.mock.calls.length, 1);
  });

  // --- Agent status ---

  it('handles setAgentStatus thinking', async () => {
    const res = await postCommand(port, 'setAgentStatus', { status: 'thinking' });
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'Agent status: thinking');
    const item = vscodeMock.mockStatusBarItem;
    assert.equal(item.text, '$(loading~spin)');
    assert.equal(item.tooltip, 'Agent is working...');
    assert.equal(item.color, undefined);
    assert.ok(item.show.mock.calls.length >= 1);
  });

  it('handles setAgentStatus idle', async () => {
    const res = await postCommand(port, 'setAgentStatus', { status: 'idle' });
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'Agent status: idle');
    const item = vscodeMock.mockStatusBarItem;
    assert.equal(item.text, '$(circle-filled)');
    assert.equal(item.tooltip, 'Waiting for you');
    assert.equal(item.color.id, 'testing.iconPassed');
    assert.ok(item.show.mock.calls.length >= 1);
  });

  it('handles setAgentStatus off (hides item)', async () => {
    await postCommand(port, 'setAgentStatus', { status: 'thinking' });
    const res = await postCommand(port, 'setAgentStatus', { status: 'off' });
    assert.equal(res.status, 200);
    assert.equal(res.body.result, 'Agent status: off');
    assert.ok(vscodeMock.mockStatusBarItem.hide.mock.calls.length >= 1);
  });
});
