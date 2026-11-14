import assert from 'node:assert/strict';
import { test } from 'node:test';
import { McpHttpBridge, validateBridgeConfig } from '../dist/mcp-stdio.js';

const TOKEN = 'fixture-mcp-private-bearer-token-78126';
const URL = 'http://fixture.invalid/mcp/comfyui';
const PROTOCOL = '2025-03-26';
const rpc = (id, method, params) => ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) });
const tool = name => ({ name, description: `Tool ${name}`, inputSchema: { type: 'object', properties: {} } });

function jsonReply(message, result, headers = {}) {
    return Response.json({ jsonrpc: '2.0', id: message.id, result }, { headers });
}

function fixture(t, { enabledTools = ['read'], respond, sse = false, session = true } = {}) {
    const calls = [];
    const cancelledStreams = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, URL);
        assert.equal(init.redirect, 'error');
        assert.ok(init.signal instanceof AbortSignal);
        assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
        const message = init.body ? JSON.parse(init.body) : undefined;
        const call = { method: init.method, message, headers: init.headers, signal: init.signal };
        calls.push(call);
        if (respond) {
            const response = await respond(call);
            if (response !== undefined) return response;
        }
        if (init.method === 'DELETE') return new Response(null, { status: 204 });
        if (message.id === undefined) return new Response(null, { status: 202 });
        let result;
        if (message.method === 'initialize') {
            result = { protocolVersion: PROTOCOL, capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} }, serverInfo: { name: 'fixture-upstream', version: '1' } };
        } else if (message.method === 'tools/list') result = { tools: [tool('read'), tool('write')] };
        else result = { content: [{ type: 'text', text: '工具结果 😀' }] };
        const headers = session && message.method === 'initialize' ? { 'Mcp-Session-Id': 'fixture-session' } : {};
        if (!sse) return jsonReply(message, result, headers);
        const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result }, null, 2);
        const text = ': keepalive\r\n\r\n'
            + 'event: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\n'
            + 'data: {"jsonrpc":"2.0","id":"unrelated","result":{}}\r\n\r\n'
            + 'event: message\r\n' + payload.split('\n').map(line => `data: ${line}\r\n`).join('') + '\r\n';
        return new Response(new ReadableStream({
            start(controller) {
                // Split UTF-8 characters and CRLF boundaries. Leave the stream
                // open: receiving the matching response must be sufficient.
                for (const byte of new TextEncoder().encode(text)) controller.enqueue(Uint8Array.of(byte));
            },
            cancel() { cancelledStreams.push(message.id); },
        }), { headers: { ...headers, 'Content-Type': 'text/event-stream' } });
    });
    const bridge = new McpHttpBridge(validateBridgeConfig({ url: URL, tokenEnv: 'JS_AGENT_RUNTIME_MCP_TOKEN_0', enabledTools }), TOKEN);
    t.after(() => bridge.close());
    return { bridge, calls, cancelledStreams };
}

async function initialize(bridge, id = 1) {
    const result = await bridge.handle(rpc(id, 'initialize', { protocolVersion: PROTOCOL, capabilities: { roots: {}, sampling: {} }, clientInfo: { name: 'private-client', version: 'fixture' } }));
    assert.equal(result.id, id);
    assert.equal(result.result.protocolVersion, PROTOCOL);
    assert.deepEqual(result.result.capabilities, { tools: {} });
    return result;
}

function assertSafeError(response, code = -32000) {
    assert.equal(response.error.code, code);
    assert.equal(JSON.stringify(response).includes(TOKEN), false);
    assert.equal(JSON.stringify(response).includes(Buffer.from(TOKEN).toString('base64')), false);
}

for (const sse of [false, true]) {
    test(`MCP bridge supports ${sse ? 'streamed SSE' : 'JSON'} responses, filters tools and closes its session`, async t => {
        const f = fixture(t, { sse });
        await initialize(f.bridge);
        assert.equal(await f.bridge.handle(rpc(undefined, 'notifications/initialized')), undefined);
        const listed = await f.bridge.handle(rpc(2, 'tools/list'));
        assert.deepEqual(listed.result.tools.map(item => item.name), ['read']);
        const called = await f.bridge.handle(rpc(3, 'tools/call', { name: 'read', arguments: { text: 'input' } }));
        assert.deepEqual(called.result.content, [{ type: 'text', text: '工具结果 😀' }]);
        assert.deepEqual(f.calls[0].message.params.capabilities, {});
        assert.equal(f.calls[0].message.params.clientInfo.name, 'js-agent-runtime');
        for (const call of f.calls.slice(1)) {
            assert.equal(call.headers['Mcp-Session-Id'], 'fixture-session');
            assert.equal(call.headers['MCP-Protocol-Version'], PROTOCOL);
        }
        assert.deepEqual(f.calls.find(call => call.message?.method === 'tools/call').message.params, { name: 'read', arguments: { text: 'input' } });
        if (sse) assert.equal(f.cancelledStreams.length, 3);
        await f.bridge.close();
        assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
        await f.bridge.close();
        assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
    });
}

test('MCP bridge joins paginated catalogs and applies the policy on every page', async t => {
    const f = fixture(t, { respond: async ({ message }) => {
        if (message?.method !== 'tools/list') return;
        if (!message.params.cursor) return jsonReply(message, { tools: [tool('write')], nextCursor: 'page-2' });
        assert.equal(message.params.cursor, 'page-2');
        return jsonReply(message, { tools: [tool('read')] });
    } });
    await initialize(f.bridge);
    const listed = await f.bridge.handle(rpc(2, 'tools/list'));
    assert.deepEqual(listed.result.tools.map(item => item.name), ['read']);
    assert.equal(listed.result.nextCursor, undefined);
    assert.equal(f.calls.filter(call => call.message?.method === 'tools/list').length, 2);
});

test('MCP bridge denies tools before forwarding and rejects non-tool capabilities', async t => {
    const f = fixture(t, { enabledTools: ['read', 'ghost'] });
    const premature = await f.bridge.handle(rpc(1, 'tools/list'));
    assertSafeError(premature);
    assert.equal(f.calls.length, 0);
    await initialize(f.bridge, 2);
    const before = f.calls.length;
    assertSafeError(await f.bridge.handle(rpc(3, 'tools/call', { name: 'write', arguments: {} })));
    assert.equal(f.calls.length, before);
    assertSafeError(await f.bridge.handle(rpc(4, 'tools/call', { name: 'ghost', arguments: {} })));
    assert.equal(f.calls.filter(call => call.message?.method === 'tools/call').length, 0);
    const after = f.calls.length;
    for (const method of ['resources/list', 'resources/read', 'prompts/list', 'sampling/createMessage']) {
        assertSafeError(await f.bridge.handle(rpc(method, method)), -32601);
    }
    assert.equal(f.calls.length, after);
    assert.deepEqual((await f.bridge.handle(rpc('ping', 'ping'))).result, {});
});

test('MCP bridge validates repeated cursors and duplicate tool names instead of returning a partial catalog', async t => {
    for (const duplicate of [false, true]) {
        await t.test(duplicate ? 'duplicate tool name' : 'repeated cursor', async child => {
            const f = fixture(child, { respond: async ({ message }) => {
                if (message?.method !== 'tools/list') return;
                return jsonReply(message, { tools: [tool(duplicate || !message.params.cursor ? 'read' : 'write')], nextCursor: 'again' });
            } });
            await initialize(f.bridge);
            assertSafeError(await f.bridge.handle(rpc(2, 'tools/list')));
            assert.equal(f.calls.filter(call => call.message?.method === 'tools/list').length, 2);
        });
    }
});

test('MCP bridge hides transport, HTTP, redirect and JSON-RPC error bodies', async t => {
    for (const mode of ['transport', 'http', 'redirect', 'rpc', 'wrong-id', 'invalid-json']) {
        await t.test(mode, async child => {
            const f = fixture(child, { respond: async ({ message }) => {
                if (message?.method !== 'tools/call') return;
                if (mode === 'transport') throw new Error(`connection refused ${TOKEN}`);
                if (mode === 'http') return new Response(TOKEN, { status: 403 });
                if (mode === 'redirect') return new Response(TOKEN, { status: 302, headers: { Location: `http://redirect.invalid/${TOKEN}` } });
                if (mode === 'rpc') return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: TOKEN, data: { secret: TOKEN } } });
                if (mode === 'wrong-id') return Response.json({ jsonrpc: '2.0', id: 'wrong', result: { content: [{ type: 'text', text: TOKEN }] } });
                return new Response(TOKEN, { headers: { 'Content-Type': 'application/json' } });
            } });
            await initialize(f.bridge);
            assertSafeError(await f.bridge.handle(rpc(2, 'tools/call', { name: 'read' })));
            assert.equal(f.calls.filter(call => call.message?.method === 'tools/call').length, 1);
        });
    }
});

test('MCP bridge does not expose its token through an upstream tool error result', async t => {
    const f = fixture(t, { respond: async ({ message }) => {
        if (message?.method === 'tools/call') return jsonReply(message, {
            isError: true, content: [{ type: 'text', text: `upstream error ${TOKEN} ${Buffer.from(TOKEN).toString('base64')}` }],
        });
    } });
    await initialize(f.bridge);
    const reply = await f.bridge.handle(rpc(2, 'tools/call', { name: 'read' }));
    assert.equal(JSON.stringify(reply).includes(TOKEN), false);
    assert.equal(JSON.stringify(reply).includes(Buffer.from(TOKEN).toString('base64')), false);
});

test('MCP catalog redacts credential echoes while preserving valid schema property names', async t => {
    const f = fixture(t, { respond: async ({ message }) => {
        if (message?.method === 'tools/list') return jsonReply(message, { tools: [{
            ...tool('read'), description: `upstream description ${TOKEN}`,
            inputSchema: { type: 'object', properties: { password: { type: 'string' }, authorization: { type: 'string' } } },
        }] });
    } });
    await initialize(f.bridge);
    const reply = await f.bridge.handle(rpc(2, 'tools/list'));
    assert.equal(JSON.stringify(reply).includes(TOKEN), false);
    assert.deepEqual(reply.result.tools[0].inputSchema.properties, { password: { type: 'string' }, authorization: { type: 'string' } });
});

test('MCP cancellation aborts a pending request and duplicate IDs cannot replace its controller', async t => {
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    let aborted = false;
    const f = fixture(t, { respond: async ({ message, signal }) => {
        if (message?.method !== 'tools/call') return;
        started();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error(TOKEN));
        }, { once: true }));
    } });
    await initialize(f.bridge);
    const pending = f.bridge.handle(rpc(2, 'tools/call', { name: 'read' }));
    await waiting;
    assertSafeError(await f.bridge.handle(rpc(2, 'tools/call', { name: 'read' })), -32600);
    assert.equal(await f.bridge.handle(rpc(undefined, 'notifications/cancelled', { requestId: 2 })), undefined);
    const reply = await pending;
    assertSafeError(reply);
    assert.match(reply.error.message, /cancelled|timed out/);
    assert.equal(aborted, true);
    assert.equal(f.calls.filter(call => call.message?.method === 'tools/call').length, 1);
});

test('MCP close aborts in-flight calls and still attempts DELETE cleanup', async t => {
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    let aborted = false;
    const f = fixture(t, { respond: async ({ message, signal }) => {
        if (message?.method !== 'tools/call') return;
        started();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error(TOKEN));
        }, { once: true }));
    } });
    await initialize(f.bridge);
    const pending = f.bridge.handle(rpc('pending', 'tools/call', { name: 'read' }));
    await waiting;
    await f.bridge.close();
    assertSafeError(await pending);
    assert.equal(aborted, true);
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 1);
});

test('MCP request deadline aborts an unresponsive upstream without echoing its error', { timeout: 1000 }, async t => {
    const originalSetTimeout = globalThis.setTimeout;
    let deadline;
    t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
        if (delay >= 300_000) deadline = delay;
        return originalSetTimeout(callback, delay >= 300_000 ? 5 : delay, ...args);
    });
    const f = fixture(t, { respond: async ({ message, signal }) => {
        if (message?.method !== 'tools/call') return;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(TOKEN)), { once: true }));
    } });
    await initialize(f.bridge);
    const reply = await f.bridge.handle(rpc(2, 'tools/call', { name: 'read' }));
    assertSafeError(reply);
    assert.match(reply.error.message, /timed out/);
    assert.ok(deadline >= 300_000);
});

test('MCP bridge rejects oversized streams without returning partial upstream text', async t => {
    let cancelled = false;
    const f = fixture(t, { respond: async ({ message }) => {
        if (message?.method !== 'tools/call') return;
        return new Response(new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); },
            cancel() { cancelled = true; },
        }), { headers: { 'Content-Type': 'application/json' } });
    } });
    await initialize(f.bridge);
    assertSafeError(await f.bridge.handle(rpc(2, 'tools/call', { name: 'read' })));
    assert.equal(cancelled, true);
});

test('MCP bridge configuration refuses credentials in URLs and unsupported environment or tool references', () => {
    for (const change of [
        { url: 'file:///tmp/mcp' }, { url: `http://user:${TOKEN}@fixture.invalid/mcp` },
        { url: `http://fixture.invalid/mcp?token=${TOKEN}` }, { url: 'http://fixture.invalid/mcp#fragment' },
        { tokenEnv: 'ARBITRARY_SECRET' }, { enabledTools: ['read', '*'] }, { enabledTools: ['../other'] },
    ]) {
        assert.throws(() => validateBridgeConfig({ url: URL, tokenEnv: 'JS_AGENT_RUNTIME_MCP_TOKEN_0', ...change }));
    }
});
