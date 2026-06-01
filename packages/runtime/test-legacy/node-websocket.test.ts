import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createFlueContext,
	InMemoryRunRegistry,
	InMemoryRunStore,
	InMemorySessionStore,
	type RunRecord,
	type RunStore,
} from '../src/internal.ts';
import {
	createNodeWebSocketTransport,
	type NodeWebSocketTransport,
	type NodeWebSocketTransportOptions,
} from '../src/node/index.ts';
import type { FlueEvent, WebSocketServerMessage } from '../src/types.ts';

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const close of closeCallbacks.splice(0)) await close();
});

describe('Node WebSocket transport', () => {
	it('keeps agent sockets open across sequential prompts', async () => {
		const { socket, messages } = await startAgentSocket();
		await waitForMessage(messages, (message) => message.type === 'ready');

		socket.send(
			JSON.stringify({
				version: 1,
				type: 'prompt',
				requestId: 'one',
				message: 'first',
				session: 'chat',
			}),
		);
		const first = await waitForMessage(
			messages,
			(message) => message.type === 'result' && message.requestId === 'one',
		);
		expect(first).toMatchObject({ result: { message: 'first', session: 'chat' } });
		expect(first).not.toHaveProperty('runId');

		socket.send(
			JSON.stringify({ version: 1, type: 'prompt', requestId: 'two', message: 'second' }),
		);
		const second = await waitForMessage(
			messages,
			(message) => message.type === 'result' && message.requestId === 'two',
		);
		expect(second).toMatchObject({ result: { message: 'second' } });
		expect(messages.filter((message) => message.type === 'started')).toHaveLength(2);
		expect(socket.readyState).toBe(WebSocket.OPEN);
	});

	it('returns structured errors for invalid agent messages without closing the socket', async () => {
		const { socket, messages } = await startAgentSocket();
		await waitForMessage(messages, (message) => message.type === 'ready');

		socket.send('{');
		const error = await waitForMessage(messages, (message) => message.type === 'error');
		expect(error).toMatchObject({ error: { type: 'invalid_request' } });
		expect(socket.readyState).toBe(WebSocket.OPEN);
	});

	it('terminates server sockets after transport-level errors', async () => {
		const { socket, transport } = await startAgentSocket();
		const accepted = [...transport.server.clients][0];
		if (!accepted) throw new Error('Expected accepted server socket.');
		accepted.emit('error', new Error('transport failed'));
		await new Promise<void>((resolve) =>
			socket.addEventListener('close', () => resolve(), { once: true }),
		);
		expect(transport.server.clients.size).toBe(0);
	});

	it('runs one workflow invocation through admission and closes normally after its result', async () => {
		let admissions = 0;
		const { socket, messages } = await startWorkflowSocket({
			workflowHandlers: {
				job: async (ctx) => {
					ctx.log.info('working');
					return ctx.payload;
				},
			},
			startWorkflowAdmission: async (runId, run) => {
				admissions++;
				expect(runId.startsWith('workflow:job:')).toBe(true);
				return run();
			},
		});
		await waitForMessage(messages, (message) => message.type === 'ready');
		const closed = waitForClose(socket);

		socket.send(
			JSON.stringify({ version: 1, type: 'invoke', requestId: 'work-1', payload: { ok: true } }),
		);
		const result = await waitForMessage(
			messages,
			(message) => message.type === 'result' && message.requestId === 'work-1',
		);

		expect(admissions).toBe(1);
		expect(messages[0]).toMatchObject({ type: 'ready', target: 'workflow', name: 'job' });
		expect(messages[1]).toMatchObject({ type: 'started', requestId: 'work-1' });
		expect(messages).toContainEqual(
			expect.objectContaining({
				type: 'event',
				requestId: 'work-1',
				event: expect.objectContaining({ type: 'run_start' }),
			}),
		);
		expect(messages.findIndex((message) => message.type === 'started')).toBeLessThan(
			messages.findIndex((message) => message.type === 'event'),
		);
		expect(result).toMatchObject({ result: { ok: true } });
		expect(await closed).toEqual({ code: 1000, reason: 'Workflow completed' });
	});

	it('normalizes an omitted workflow payload for recoverable admission', async () => {
		const runStore = new InMemoryRunStore();
		const { socket, messages } = await startWorkflowSocket({ runStore });
		await waitForMessage(messages, (message) => message.type === 'ready');

		socket.send(JSON.stringify({ version: 1, type: 'invoke', requestId: 'work-empty' }));
		const result = await waitForMessage(
			messages,
			(message) => message.type === 'result' && message.requestId === 'work-empty',
		);
		if (!('runId' in result) || typeof result.runId !== 'string')
			throw new Error('Expected workflow run id.');

		expect(await runStore.getRun(result.runId)).toMatchObject({ payload: {}, result: {} });
		expect(result).toMatchObject({ result: {} });
	});

	it('preserves an explicit null workflow payload', async () => {
		const runStore = new InMemoryRunStore();
		const { socket, messages } = await startWorkflowSocket({ runStore });
		await waitForMessage(messages, (message) => message.type === 'ready');

		socket.send(
			JSON.stringify({ version: 1, type: 'invoke', requestId: 'work-null', payload: null }),
		);
		const result = await waitForMessage(
			messages,
			(message) => message.type === 'result' && message.requestId === 'work-null',
		);
		if (!('runId' in result) || typeof result.runId !== 'string')
			throw new Error('Expected workflow run id.');

		expect(await runStore.getRun(result.runId)).toMatchObject({ payload: null, result: null });
		expect(result).toMatchObject({ result: null });
	});

	it('does not send started when workflow execution scheduling rejects asynchronously', async () => {
		let executions = 0;
		const { socket, messages } = await startWorkflowSocket({
			workflowHandlers: {
				job: async () => {
					executions++;
					return null;
				},
			},
			startWorkflowAdmission: async () => {
				throw new Error('scheduler unavailable');
			},
		});
		await waitForMessage(messages, (message) => message.type === 'ready');
		const closed = waitForClose(socket);

		socket.send(
			JSON.stringify({ version: 1, type: 'invoke', requestId: 'work-scheduling-failed' }),
		);
		const error = await waitForMessage(
			messages,
			(message) => message.type === 'error' && message.requestId === 'work-scheduling-failed',
		);

		expect(executions).toBe(0);
		expect(messages.some((message) => message.type === 'started')).toBe(false);
		expect(error).toMatchObject({ runId: expect.stringMatching(/^workflow:job:/) });
		expect(await closed).toEqual({ code: 1011, reason: 'Workflow failed' });
	});

	it('does not send started or execute a workflow when admission persistence fails', async () => {
		let admissions = 0;
		let executions = 0;
		const { socket, messages } = await startWorkflowSocket({
			workflowHandlers: {
				job: async () => {
					executions++;
					return null;
				},
			},
			startWorkflowAdmission: async (_runId, run) => {
				admissions++;
				return run();
			},
			runStore: new FailingRunStore(),
		});
		await waitForMessage(messages, (message) => message.type === 'ready');
		const closed = waitForClose(socket);

		socket.send(
			JSON.stringify({
				version: 1,
				type: 'invoke',
				requestId: 'work-failed',
				payload: { ok: true },
			}),
		);
		const error = await waitForMessage(
			messages,
			(message) => message.type === 'error' && message.requestId === 'work-failed',
		);

		expect(admissions).toBe(0);
		expect(executions).toBe(0);
		expect(messages.some((message) => message.type === 'started')).toBe(false);
		expect(error).toMatchObject({ runId: expect.stringMatching(/^workflow:job:/) });
		expect(await closed).toEqual({ code: 1011, reason: 'Workflow failed' });
	});

	it('accepts one workflow invocation only', async () => {
		let executions = 0;
		let release: (() => void) | undefined;
		const runStore = new InMemoryRunStore();
		const { socket, messages } = await startWorkflowSocket({
			runStore,
			workflowHandlers: {
				job: async () => {
					executions++;
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return null;
				},
			},
		});
		await waitForMessage(messages, (message) => message.type === 'ready');
		socket.send(JSON.stringify({ version: 1, type: 'invoke', requestId: 'work-one' }));
		const started = await waitForMessage(
			messages,
			(message) => message.type === 'started' && message.requestId === 'work-one',
		);
		if (!('runId' in started) || typeof started.runId !== 'string')
			throw new Error('Expected workflow run id.');
		const closed = waitForClose(socket);

		try {
			socket.send(JSON.stringify({ version: 1, type: 'invoke', requestId: 'work-two' }));
			const error = await waitForMessage(
				messages,
				(message) => message.type === 'error' && message.requestId === 'work-two',
			);

			expect(error).toMatchObject({ error: { type: 'invalid_request' } });
			expect(executions).toBe(1);
			expect(await closed).toEqual({ code: 1008, reason: 'Workflow accepts one invocation only' });
		} finally {
			release?.();
			await waitFor(async () => (await runStore.getRun(started.runId))?.status === 'completed');
		}
	});
});

class FailingRunStore implements RunStore {
	async createRun(_input: Parameters<RunStore['createRun']>[0]): Promise<void> {
		throw new Error('create failed');
	}

	async endRun(_input: Parameters<RunStore['endRun']>[0]): Promise<void> {}

	async appendEvent(_runId: string, _event: FlueEvent): Promise<void> {}

	async getEvents(_runId: string, _fromIndex?: number): Promise<FlueEvent[]> {
		return [];
	}

	async getRun(_runId: string): Promise<RunRecord | null> {
		return null;
	}
}

interface StartedSocket {
	socket: WebSocket;
	messages: WebSocketServerMessage[];
	transport: NodeWebSocketTransport;
}

async function startAgentSocket(
	options?: Partial<NodeWebSocketTransportOptions>,
): Promise<StartedSocket> {
	return startSocket('agent', options);
}

async function startWorkflowSocket(
	options?: Partial<NodeWebSocketTransportOptions>,
): Promise<StartedSocket> {
	return startSocket('workflow', options);
}

async function startSocket(
	target: 'agent' | 'workflow',
	options?: Partial<NodeWebSocketTransportOptions>,
): Promise<StartedSocket> {
	const transport = createTransport(options);
	const app = new Hono();
	const path = target === 'agent' ? '/agents/:name/:id' : '/workflows/:name';
	app.get(path, target === 'agent' ? transport.agentRoute : transport.workflowRoute);
	const server = serve({ fetch: app.fetch, websocket: { server: transport.server }, port: 0 });
	await new Promise<void>((resolve) => server.once('listening', resolve));
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Expected test server address.');
	const url = target === 'agent' ? '/agents/assistant/instance-1' : '/workflows/job';
	const socket = new WebSocket(`ws://localhost:${address.port}${url}`);
	const messages = collectMessages(socket);
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener('open', () => resolve(), { once: true });
		socket.addEventListener('error', () => reject(new Error('WebSocket failed before opening.')), {
			once: true,
		});
	});
	closeCallbacks.push(async () => {
		if (socket.readyState === WebSocket.OPEN) {
			await new Promise<void>((resolve) => {
				socket.addEventListener('close', () => resolve(), { once: true });
				socket.close();
			});
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return { socket, messages, transport };
}

function createTransport(
	options: Partial<NodeWebSocketTransportOptions> = {},
): NodeWebSocketTransport {
	return createNodeWebSocketTransport({
		manifest: {
			agents: [{ name: 'assistant', transports: { websocket: true }, created: true }],
			workflows: [{ name: 'job', transports: { websocket: true } }],
		},
		agentHandlers: {
			assistant: async (ctx) => ctx.payload,
		},
		workflowHandlers: {
			job: async (ctx) => ctx.payload,
		},
		createContext,
		runStore: new InMemoryRunStore(),
		runRegistry: new InMemoryRunRegistry(),
		...options,
	});
}

function createContext(id: string, runId: string | undefined, payload: unknown, req: Request) {
	return createFlueContext({
		id,
		runId,
		payload,
		req,
		env: {},
		agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
		createDefaultEnv: async () => ({}) as never,
		defaultStore: new InMemorySessionStore(),
	});
}

function collectMessages(socket: WebSocket): WebSocketServerMessage[] {
	const messages: WebSocketServerMessage[] = [];
	socket.addEventListener('message', (event) => {
		messages.push(JSON.parse(String(event.data)) as WebSocketServerMessage);
	});
	return messages;
}

async function waitForMessage(
	messages: WebSocketServerMessage[],
	predicate: (message: WebSocketServerMessage) => boolean,
): Promise<WebSocketServerMessage> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const message = messages.find(predicate);
		if (message) return message;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Expected WebSocket message not received: ${JSON.stringify(messages)}`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('Expected condition was not met.');
}

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
	return new Promise((resolve) => {
		socket.addEventListener(
			'close',
			(event) => resolve({ code: event.code, reason: event.reason }),
			{ once: true },
		);
	});
}
