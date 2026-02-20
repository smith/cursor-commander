import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const PORT_FILE = path.join(os.homedir(), '.cursor-commander-port');
const BRIDGE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  'mcp-bridge.mjs',
);

// Fake HTTP server that mimics the extension
function createFakeExtension() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      received.push(parsed);

      let result;
      switch (parsed.command) {
        case 'saveAll':
          result = 'All files saved';
          break;
        case 'closeAllEditors':
          result = 'All editors closed';
          break;
        case 'getOpenFiles':
          result = ['/a.txt', '/b.txt'];
          break;
        case 'openFile':
          result = `Opened ${parsed.args.path}`;
          break;
        case 'showMessage':
          result = 'Message shown';
          break;
        default:
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: false,
              error: `Unknown command: ${parsed.command}`,
            }),
          );
          return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
    });
  });

  return { server, received };
}

function sendMcpRequest(child, id, method, params = {}) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  child.stdin.write(msg + '\n');
}

function readMcpResponses(child, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const responses = [];
    let buffer = '';
    const timer = setTimeout(() => resolve(responses), timeout);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          responses.push(JSON.parse(trimmed));
        } catch {
          // ignore non-JSON lines
        }
      }
    });

    child.on('close', () => {
      clearTimeout(timer);
      resolve(responses);
    });
  });
}

function waitForResponse(child, id, timeout = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () => reject(new Error(`Timeout waiting for response id=${id}`)),
      timeout,
    );

    const onData = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.id === id) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve(parsed);
            return;
          }
        } catch {
          // ignore
        }
      }
    };

    child.stdout.on('data', onData);
  });
}

describe('MCP Bridge', () => {
  let fakeExt;
  let fakePort;
  let child;

  beforeEach(async () => {
    fakeExt = createFakeExtension();
    await new Promise((resolve) => {
      fakeExt.server.listen(0, '127.0.0.1', () => {
        fakePort = fakeExt.server.address().port;
        fs.writeFileSync(PORT_FILE, String(fakePort));
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (child && !child.killed) {
      child.kill();
      await new Promise((resolve) => child.on('close', resolve));
    }
    fakeExt.server.close();
    try {
      fs.unlinkSync(PORT_FILE);
    } catch {}
  });

  it('responds to tools/list with all 7 tools', async () => {
    child = spawn('node', [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // MCP requires initialize first
    sendMcpRequest(child, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.1' },
    });
    const initResp = await waitForResponse(child, 1);
    assert.ok(initResp.result, 'initialize should return result');

    // Send initialized notification (no id)
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 200));

    sendMcpRequest(child, 2, 'tools/list');
    const resp = await waitForResponse(child, 2);

    assert.ok(resp.result, 'tools/list should return result');
    const toolNames = resp.result.tools.map((t) => t.name).sort();
    assert.deepEqual(toolNames, [
      'close_active_editor',
      'close_all_editors',
      'execute_command',
      'get_open_files',
      'open_file',
      'save_all_files',
      'show_message',
    ]);
  });

  it('calls save_all_files and gets result', async () => {
    child = spawn('node', [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    sendMcpRequest(child, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.1' },
    });
    await waitForResponse(child, 1);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 200));

    sendMcpRequest(child, 2, 'tools/call', {
      name: 'save_all_files',
      arguments: {},
    });
    const resp = await waitForResponse(child, 2);
    assert.ok(resp.result);
    assert.equal(resp.result.content[0].text, 'All files saved');
    assert.equal(fakeExt.received[0].command, 'saveAll');
  });

  it('calls get_open_files and returns file list', async () => {
    child = spawn('node', [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    sendMcpRequest(child, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.1' },
    });
    await waitForResponse(child, 1);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 200));

    sendMcpRequest(child, 2, 'tools/call', {
      name: 'get_open_files',
      arguments: {},
    });
    const resp = await waitForResponse(child, 2);
    assert.ok(resp.result);
    const parsed = JSON.parse(resp.result.content[0].text);
    assert.deepEqual(parsed, ['/a.txt', '/b.txt']);
  });

  it('calls open_file with path argument', async () => {
    child = spawn('node', [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    sendMcpRequest(child, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.1' },
    });
    await waitForResponse(child, 1);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 200));

    sendMcpRequest(child, 2, 'tools/call', {
      name: 'open_file',
      arguments: { path: '/tmp/hello.md' },
    });
    const resp = await waitForResponse(child, 2);
    assert.ok(resp.result);
    assert.equal(resp.result.content[0].text, 'Opened /tmp/hello.md');
    assert.equal(fakeExt.received[0].args.path, '/tmp/hello.md');
  });

  it('returns error for unknown tool', async () => {
    child = spawn('node', [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    sendMcpRequest(child, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.1' },
    });
    await waitForResponse(child, 1);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 200));

    sendMcpRequest(child, 2, 'tools/call', {
      name: 'nonexistent_tool',
      arguments: {},
    });
    const resp = await waitForResponse(child, 2);
    assert.ok(resp.result);
    assert.equal(resp.result.isError, true);
    assert.match(resp.result.content[0].text, /Unknown tool/);
  });
});

describe('MCP Bridge - no extension running', () => {
  beforeEach(() => {
    try {
      fs.unlinkSync(PORT_FILE);
    } catch {}
  });

  it('returns error when port file is missing', async () => {
    const child = spawn('node', [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    sendMcpRequest(child, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.1' },
    });
    await waitForResponse(child, 1);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n',
    );
    await new Promise((r) => setTimeout(r, 200));

    sendMcpRequest(child, 2, 'tools/call', {
      name: 'save_all_files',
      arguments: {},
    });
    const resp = await waitForResponse(child, 2);
    assert.ok(resp.result);
    assert.equal(resp.result.isError, true);
    assert.match(resp.result.content[0].text, /not running/);

    child.kill();
    await new Promise((resolve) => child.on('close', resolve));
  });
});
