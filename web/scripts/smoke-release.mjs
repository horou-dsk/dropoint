import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

assert.ok(process.argv[2], 'Usage: node web/scripts/smoke-release.mjs <binary>');
const source = resolve(process.argv[2]);
// This directory belongs exclusively to this test, and is always removed below.
const temporaryParent = resolve(tmpdir());
const runtime = await mkdtemp(join(temporaryParent, 'dropoint-smoke-'));
let child;
let output = '';
try {
  const executable = join(runtime, basename(source));
  const share = join(runtime, 'shared files');
  await copyFile(source, executable);
  await chmod(executable, 0o755);
  await mkdir(share);
  await writeFile(join(share, 'hello.txt'), 'hello from the shared directory');
  await writeFile(join(share, 'index.html'), 'shared content must not replace the UI');
  await writeFile(join(runtime, 'outside.txt'), 'outside the shared directory');

  child = spawn(executable, [share, '--port', '0'], {
    cwd: runtime,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const origin = await new Promise((resolveOrigin, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), 15_000);
    function fail(error) {
      clearTimeout(timer);
      reject(error);
    }
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`Server exited with ${code}:\n${output}`)));
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const port = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/)?.[1];
      if (port) {
        clearTimeout(timer);
        resolveOrigin(`http://127.0.0.1:${port}`);
      }
    });
  });
  const request = (path, options = {}) => fetch(`${origin}${path}`, {
    ...options,
    signal: AbortSignal.timeout(10_000),
  });

  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const html = await page.text();
  assert.match(html, /<div id="root"><\/div>/);
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].map((match) => match[1]);
  assert.ok(assets.some((path) => path.endsWith('.js')), 'Page must reference bundled JS');
  assert.ok(assets.some((path) => path.endsWith('.css')), 'Page must reference bundled CSS');
  for (const path of assets) {
    const asset = await request(path);
    assert.equal(asset.status, 200, path);
    assert.match(asset.headers.get('content-type'), path.endsWith('.css') ? /^text\/css/ : /javascript/);
    assert.ok((await asset.arrayBuffer()).byteLength > 0, path);
  }
  const head = await request('/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const fallback = await request('/workspace/example.v1');
  assert.equal(fallback.status, 200);
  assert.equal(await fallback.text(), html);
  for (const path of ['/api', '/api/unknown', '/assets/missing.js']) {
    const missing = await request(path);
    assert.equal(missing.status, 404, path);
    await missing.arrayBuffer();
  }
  const unknownPost = await request('/api/unknown', { method: 'POST' });
  assert.equal(unknownPost.status, 404);
  await unknownPost.arrayBuffer();
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const listing = await request('/api/files');
  assert.equal(listing.status, 200);
  const { entries } = await listing.json();
  assert.ok(entries.some((entry) => entry.name === 'hello.txt'));
  assert.ok(!entries.some((entry) => entry.name === 'outside.txt'));
  const download = await request('/api/files/download?path=hello.txt');
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'hello from the shared directory');
  const content = 'uploaded by the release smoke test';
  const form = new FormData();
  form.append('relative_path', 'uploaded.txt');
  form.append('file', new Blob([content], { type: 'text/plain' }), 'uploaded.txt');
  const upload = await request('/api/files', { method: 'POST', body: form });
  assert.equal(upload.status, 200);
  await upload.arrayBuffer();
  assert.equal(await readFile(join(share, 'uploaded.txt'), 'utf8'), content);
  const uploaded = await request('/api/files/download?path=uploaded.txt');
  assert.equal(uploaded.status, 200);
  assert.equal(await uploaded.text(), content);
  const traversal = await request('/api/files/download?path=../outside.txt');
  assert.ok([400, 404].includes(traversal.status));
  await traversal.arrayBuffer();

  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/chat`);
  try {
    await new Promise((resolveChat, reject) => {
      const timer = setTimeout(() => finish(new Error('WebSocket timed out')), 10_000);
      function finish(error) {
        clearTimeout(timer);
        if (error) reject(error);
        else resolveChat();
      }
      let receivedHistory = false;
      socket.onerror = () => finish(new Error('WebSocket connection failed'));
      socket.onclose = () => finish(new Error('WebSocket closed before receiving a message'));
      socket.onmessage = ({ data }) => {
        try {
          const event = JSON.parse(data);
          if (event.type === 'history') {
            assert.deepEqual(event.messages, []);
            receivedHistory = true;
            socket.send(JSON.stringify({ type: 'send', text: 'release smoke test' }));
          } else {
            assert.ok(receivedHistory);
            assert.equal(event.type, 'message');
            assert.equal(event.message.text, 'release smoke test');
            finish();
          }
        } catch (error) {
          finish(error);
        }
      };
    });
  } finally {
    socket.close();
  }
  console.log('Standalone binary passed: embedded HTML/JS/CSS, HEAD, SPA, API 404, health, files, upload/download and WebSocket.');
} catch (error) {
  console.error(output);
  throw error;
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close');
    child.kill();
    await closed;
  }
  // Verify the absolute cleanup target before removing only this test's files.
  assert.equal(dirname(runtime), temporaryParent);
  assert.ok(basename(runtime).startsWith('dropoint-smoke-'));
  await rm(runtime, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
