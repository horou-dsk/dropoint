import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.ok(process.argv[2], 'Usage: node web/scripts/smoke-release.mjs <binary>');
const source = resolve(process.argv[2]);
// This directory belongs exclusively to this test, and is always removed below.
const temporaryParent = resolve(tmpdir());
const runtime = await mkdtemp(join(temporaryParent, 'dropoint-smoke-'));
let child;
let output = '';
const serverTemporary = join(runtime, 'server temporary');
let completed = false;

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

function startServer(executable, share) {
  output = '';
  child = spawn(executable, [share, '--port', '0'], {
    cwd: runtime,
    windowsHide: true,
    // All temporary attachments belong to this smoke run, including abrupt Windows shutdown.
    env: { ...process.env, TMPDIR: serverTemporary, TMP: serverTemporary, TEMP: serverTemporary },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolveOrigin, reject) => {
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
}

async function stopServer(signal = 'SIGTERM', milliseconds = 15_000) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill(signal);
  await withTimeout(closed, milliseconds, `Server did not exit after ${signal}:\n${output}`);
}

async function verifyShutdown(executable, share) {
  // Node cannot send console Ctrl+C to a Windows child; exercise real Unix signals here.
  for (const mode of ['finish', 'interrupt', 'timeout']) {
    const origin = await startServer(executable, share);
    const archive = await fetch(`${origin}/api/files/archive`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['hello.txt'] }), signal: AbortSignal.timeout(5_000),
    });
    assert.equal(archive.status, 200);
    await archive.arrayBuffer();
    const prefix = Buffer.concat([
      Buffer.from('--shutdown\r\nContent-Disposition: form-data; name="file"; filename="stalled.png"\r\n\r\n'),
      Buffer.alloc(65_536, 'x'),
    ]);
    const suffix = Buffer.from('\r\n--shutdown--\r\n');
    const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(origin).port) });
    const response = [];
    socket.on('error', () => {});
    socket.on('data', (chunk) => response.push(chunk));
    try {
      await withTimeout(once(socket, 'connect'), 5_000, 'Upload socket did not connect');
      socket.write(`POST /api/chat/attachments HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Type: multipart/form-data; boundary=shutdown\r\nContent-Length: ${prefix.length + suffix.length}\r\n\r\n`);
      socket.write(prefix);
      // Wait for a partial file on disk, proving the handler is blocked inside an active upload.
      const deadline = Date.now() + 5_000;
      let written = false;
      while (!written && Date.now() < deadline) {
        for (const entry of await readdir(serverTemporary, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          for (const name of await readdir(join(serverTemporary, entry.name))) {
            if ((await stat(join(serverTemporary, entry.name, name))).size > 0) written = true;
          }
        }
        if (!written) await delay(20);
      }
      assert.ok(written, `${mode}: upload must write a partial temporary file`);
      const exited = once(child, 'close');
      child.kill(mode === 'interrupt' ? 'SIGINT' : 'SIGTERM');
      // Wait until the first signal is consumed before sending another: OS signals
      // can coalesce if the runner is busy and both are sent before Tokio polls them.
      const signalDeadline = Date.now() + 5_000;
      while (!output.includes('Shutting down:')) {
        assert.ok(Date.now() < signalDeadline, `${mode}: first shutdown signal was not handled`);
        await delay(20);
      }
      assert.equal(child.exitCode, null, `${mode}: the first signal must allow the request to finish`);
      assert.equal(child.signalCode, null, `${mode}: the first signal must be handled`);
      if (mode === 'finish') {
        const closed = once(socket, 'close');
        socket.write(suffix);
        await withTimeout(closed, 5_000, 'An upload finishing during shutdown did not respond');
        const text = Buffer.concat(response).toString();
        assert.match(text, /^HTTP\/1\.1 200 /);
        assert.equal(JSON.parse(text.split('\r\n\r\n')[1]).size, 65_536);
      } else if (mode === 'interrupt') {
        // Keep the client body open: the second Ctrl+C must cancel it without a disconnect.
        child.kill('SIGINT');
      }
      await withTimeout(exited, mode === 'timeout' ? 12_000 : 2_000, `${mode}: shutdown did not finish`);
      assert.equal(child.exitCode, 0, `${mode}: shutdown must exit cleanly`);
      assert.deepEqual(await readdir(serverTemporary), [], `${mode}: temporary uploads and archives must be removed`);
    } finally { socket.destroy(); }
  }
}

try {
  const executable = join(runtime, basename(source));
  const share = join(runtime, 'shared files');
  await copyFile(source, executable);
  await chmod(executable, 0o755);
  await mkdir(share);
  await mkdir(serverTemporary);
  await writeFile(join(share, 'hello.txt'), 'hello from the shared directory');
  await writeFile(join(share, 'index.html'), 'shared content must not replace the UI');
  await writeFile(join(runtime, 'outside.txt'), 'outside the shared directory');

  const origin = await startServer(executable, share);
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
    const queue = [];
    let waiting;
    socket.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      if (waiting) waiting(null, event);
      else queue.push(event);
    };
    socket.onerror = () => waiting?.(new Error('WebSocket connection failed'));
    socket.onclose = () => waiting?.(new Error('WebSocket closed before receiving a message'));
    const nextEvent = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolveEvent, reject) => {
      const timer = setTimeout(() => waiting?.(new Error('WebSocket timed out')), 10_000);
      waiting = (error, event) => {
        clearTimeout(timer);
        waiting = undefined;
        if (error) reject(error);
        else resolveEvent(event);
      };
    });
    const history = await nextEvent();
    assert.equal(history.type, 'history');
    assert.deepEqual(history.messages, []);
    socket.send(JSON.stringify({ type: 'send', text: 'release smoke test' }));
    const textEvent = await nextEvent();
    assert.equal(textEvent.type, 'message');
    assert.equal(textEvent.message.text, 'release smoke test');
    assert.deepEqual(textEvent.message.attachments, []);

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=', 'base64');
    const attachmentForm = new FormData();
    attachmentForm.append('file', new Blob([png], { type: 'image/png' }), '截图.png');
    const attachmentUpload = await request('/api/chat/attachments', { method: 'POST', body: attachmentForm });
    assert.equal(attachmentUpload.status, 200);
    const attachment = await attachmentUpload.json();
    assert.equal(attachment.name, '截图.png');
    assert.equal(attachment.mime, 'image/png');
    assert.equal(attachment.size, png.length);
    const clientMessageId = 'release-smoke-media';
    const prepared = await request('/api/chat/messages/prepare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientMessageId }),
    });
    assert.equal(prepared.status, 200);
    const { submissionToken } = await prepared.json();
    assert.equal(typeof submissionToken, 'string');
    const retainedFiles = await request('/api/chat/messages/keepalive', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientMessageId, submissionToken, attachmentIds: [attachment.id] }),
    });
    assert.equal(retainedFiles.status, 204);
    const submit = { clientMessageId, submissionToken, text: 'media smoke test', attachmentIds: [attachment.id] };
    const postMessage = () => request('/api/chat/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submit),
    });
    const published = await postMessage();
    assert.equal(published.status, 200);
    const mediaMessage = await published.json();
    const mediaEvent = await nextEvent();
    assert.equal(mediaEvent.type, 'message');
    assert.deepEqual(mediaEvent.message, mediaMessage);
    assert.deepEqual(mediaMessage.attachments, [attachment]);
    const retry = await postMessage();
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), mediaMessage);
    const preview = await request(attachment.previewUrl);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
    const attachmentDownload = await request(attachment.downloadUrl);
    assert.equal(attachmentDownload.status, 200);
    assert.match(attachmentDownload.headers.get('content-disposition'), /filename\*=UTF-8''%E6%88%AA%E5%9B%BE/);
    assert.deepEqual(Buffer.from(await attachmentDownload.arrayBuffer()), png);
    const attachmentHead = await request(attachment.previewUrl, { method: 'HEAD' });
    assert.equal(attachmentHead.status, 200);
    assert.equal(attachmentHead.headers.get('content-length'), String(png.length));
    assert.equal(await attachmentHead.text(), '');
    const range = await request(attachment.previewUrl, { headers: { Range: 'bytes=0-7' } });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), png.subarray(0, 8));
    const afterChat = await request('/api/files');
    assert.ok(!(await afterChat.json()).entries.some((entry) => entry.name === attachment.name), 'Chat uploads stay outside the shared directory');
    const reconnect = new WebSocket(`${origin.replace('http:', 'ws:')}/api/chat`);
    try {
      const retained = await new Promise((resolveHistory, reject) => {
        const timer = setTimeout(() => reject(new Error('Reconnect history timed out')), 10_000);
        reconnect.onerror = () => { clearTimeout(timer); reject(new Error('Reconnect failed')); };
        reconnect.onmessage = ({ data }) => { clearTimeout(timer); resolveHistory(JSON.parse(data)); };
      });
      assert.equal(retained.type, 'history');
      assert.equal(retained.messages.length, 2);
      assert.deepEqual(retained.messages[1], mediaMessage);
    } finally { reconnect.close(); }
    assert.equal(queue.length, 0, 'An idempotent retry must not broadcast another message');
  } finally {
    socket.close();
  }
  if (process.platform !== 'win32') {
    await stopServer();
    assert.equal(child.exitCode, 0, 'SIGTERM must shut the server down gracefully');
    assert.deepEqual(await readdir(serverTemporary), [], 'Normal shutdown must clean chat attachments');
    await verifyShutdown(executable, share);
    console.log('Shutdown passed: active upload completion, second Ctrl+C, grace timeout, temporary upload/archive cleanup.');
  }
  console.log('Standalone binary passed: embedded HTML/JS/CSS, HEAD, SPA, API 404, health, files, chat text/media broadcast, idempotent submission, attachment download and Range.');
  completed = true;
} catch (error) {
  console.error(output);
  throw error;
} finally {
  try {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      // A failed shutdown test must not leave a stalled server or hang the CI job.
      await stopServer(process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL', 5_000);
    }
    if (completed && process.platform !== 'win32') {
      assert.equal(child.exitCode, 0, 'SIGTERM must shut the server down gracefully');
      assert.deepEqual(await readdir(serverTemporary), [], 'Normal shutdown must clean chat attachments');
    }
  } finally {
    // Verify the absolute cleanup target before removing only this test's files.
    assert.equal(dirname(runtime), temporaryParent);
    assert.ok(basename(runtime).startsWith('dropoint-smoke-'));
    await rm(runtime, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
