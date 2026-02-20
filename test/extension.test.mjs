import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const PORT_FILE = path.join(os.homedir(), '.cursor-commander-port');

// --- vscode mock ---

function createVscodeMock() {
  const executedCommands = [];
  const mockTabs = [];

  return {
    executedCommands,
    mockTabs,
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
      tabGroups: {
        get all() {
          return [{ tabs: mockTabs }];
        },
      },
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
    const portStr = fs.readFileSync(PORT_FILE, 'utf-8').trim();
    port = parseInt(portStr, 10);
    assert.ok(port > 0, `Expected valid port, got ${portStr}`);
  });

  afterEach(async () => {
    loaded.ext.deactivate();
    loaded.cleanup();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  it('writes a port file on activation', () => {
    assert.ok(fs.existsSync(PORT_FILE));
    const p = parseInt(fs.readFileSync(PORT_FILE, 'utf-8').trim(), 10);
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
    assert.ok(!fs.existsSync(PORT_FILE));
  });
});
