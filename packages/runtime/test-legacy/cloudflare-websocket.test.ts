import { describe, expect, it } from 'vitest';
import {
	type CloudflareWebSocketConnection,
	connectCloudflareAgentWebSocket,
	connectCloudflareWorkflowWebSocket,
	messageCloudflareAgentWebSocket,
	messageCloudflareWorkflowWebSocket,
} from '../src/cloudflare/websocket.ts';
import {
	createFlueContext,
	InMemoryRunRegistry,
	InMemoryRunStore,
	InMemorySessionStore,
	type RunRecord,
	type RunStore,
} from '../src/internal.ts';
import type { FlueEvent, WebSocketServerMessage } from '../src/types.ts';

describe('Cloudflare WebSocket transport', () => {
	it('keeps agent sockets open across sequential prompts', async () => {
		const connection = new TestConnection();
		connectCloudflareAgentWebSocket(connection, {
			name: 'assistant',
			id: 'instance-1',
			requestUrl: 'https://example.com/agents/assistant/instance-1',
		});
		const options = agentOptions();

		await messageCloudflareAgentWebSocket(
			connection,
			JSON.stringify({
				version: 1,
				type: 'prompt',
				requestId: 'one',
				message: 'first',
				session: 'chat',
			}),
			options,
		);
		await messageCloudflareAgentWebSocket(
			connection,
			JSON.stringify({ version: 1, type: 'prompt', requestId: 'two', message: 'second' }),
			options,
		);

		expect(connection.messages[0]).toMatchObject({
			type: 'ready',
			target: 'agent',
			name: 'assistant',
			instanceId: 'instance-1',
		});
		const first = connection.messages.find(
			(message) => message.type === 'result' && message.requestId === 'one',
		);
		const second = connection.messages.find(
			(message) => message.type === 'result' && message.requestId === 'two',
		);
		expect(first).toMatchObject({ result: { message: 'first', session: 'chat' } });
		expect(first).not.toHaveProperty('runId');
		expect(second).toMatchObject({ result: { message: 'second' } });
		expect(second).not.toHaveProperty('runId');
		expect(connection.closed).toBeUndefined();
	});

	it('returns structured invalid-message errors without closing agent sockets', async () => {
		const connection = new TestConnection();
		await messageCloudflareAgentWebSocket(connection, '{', agentOptions());

		expect(connection.messages).toContainEqual(
			expect.objectContaining({
				type: 'error',
				error: expect.objectContaining({ type: 'invalid_request' }),
			}),
		);
		expect(connection.closed).toBeUndefined();
	});

	it('rejects Agents SDK reserved inbound messages as invalid Flue protocol messages', async () => {
		const connection = new TestConnection();
		await messageCloudflareAgentWebSocket(
			connection,
			JSON.stringify({ type: 'cf_agent_state', state: { tampered: true } }),
			agentOptions(),
		);

		expect(connection.messages).toContainEqual(
			expect.objectContaining({
				type: 'error',
				error: expect.objectContaining({ type: 'invalid_request' }),
			}),
		);
	});

	it('closes sockets before invoking oversized messages', async () => {
		const connection = new TestConnection();
		await messageCloudflareAgentWebSocket(
			connection,
			JSON.stringify({
				version: 1,
				type: 'prompt',
				requestId: 'large',
				message: 'x'.repeat(1024 * 1024),
			}),
			agentOptions(),
		);

		expect(connection.messages).toContainEqual(
			expect.objectContaining({
				type: 'error',
				error: expect.objectContaining({ type: 'invalid_request' }),
			}),
		);
		expect(connection.closed).toEqual({ code: 1008, reason: 'Message too large' });
	});

	it('does not fail an invocation when a disconnected socket rejects delivery', async () => {
		const connection = new TestConnection();
		connection.rejectSends = true;
		await messageCloudflareAgentWebSocket(
			connection,
			JSON.stringify({ version: 1, type: 'prompt', requestId: 'gone', message: 'continue' }),
			agentOptions(),
		);
		expect(connection.closed).toBeUndefined();
	});

	it('runs one workflow invocation through durable admission and closes normally after its result', async () => {
		const connection = new TestConnection();
		let admissions = 0;
		connectCloudflareWorkflowWebSocket(connection, {
			name: 'job',
			runId: 'workflow:job:test',
			requestUrl: 'https://example.com/workflows/job',
		});
		await messageCloudflareWorkflowWebSocket(
			connection,
			JSON.stringify({ version: 1, type: 'invoke', requestId: 'work-1', payload: { ok: true } }),
			{
				name: 'job',
				runId: 'workflow:job:test',
				request: new Request('https://example.com/workflows/job'),
				handler: async (ctx) => {
					ctx.log.info('working');
					return ctx.payload;
				},
				createContext,
				startWorkflowAdmission: async (runId, run) => {
					admissions++;
					expect(runId).toBe('workflow:job:test');
					return run();
				},
				runStore: new InMemoryRunStore(),
				runRegistry: new InMemoryRunRegistry(),
			},
		);

		expect(admissions).toBe(1);
		expect(connection.messages[0]).toMatchObject({
			type: 'ready',
			target: 'workflow',
			name: 'job',
		});
		expect(connection.messages[1]).toMatchObject({
			type: 'started',
			requestId: 'work-1',
			runId: 'workflow:job:test',
		});
		expect(connection.messages).toContainEqual(
			expect.objectContaining({
				type: 'event',
				requestId: 'work-1',
				runId: 'workflow:job:test',
				event: expect.objectContaining({ type: 'run_start' }),
			}),
		);
		expect(connection.messages.findIndex((message) => message.type === 'started')).toBeLessThan(
			connection.messages.findIndex((message) => message.type === 'event'),
		);
		expect(connection.messages).toContainEqual(
			expect.objectContaining({ type: 'result', requestId: 'work-1', result: { ok: true } }),
		);
		expect(connection.closed).toEqual({ code: 1000, reason: 'Workflow completed' });
	});

	it('does not send started when durable execution scheduling fails', async () => {
		const connection = new TestConnection();
		connectCloudflareWorkflowWebSocket(connection, {
			name: 'job',
			runId: 'workflow:job:admission-error',
			requestUrl: 'https://example.com/workflows/job',
		});
		await messageCloudflareWorkflowWebSocket(
			connection,
			JSON.stringify({
				version: 1,
				type: 'invoke',
				requestId: 'work-admission-error',
				payload: {},
			}),
			{
				name: 'job',
				runId: 'workflow:job:admission-error',
				request: new Request('https://example.com/workflows/job'),
				handler: async () => null,
				createContext,
				startWorkflowAdmission: async () => {
					throw new Error('no fiber');
				},
				runStore: new InMemoryRunStore(),
				runRegistry: new InMemoryRunRegistry(),
			},
		);

		expect(connection.messages.some((message) => message.type === 'started')).toBe(false);
		expect(connection.messages).toContainEqual(
			expect.objectContaining({
				type: 'error',
				requestId: 'work-admission-error',
				runId: 'workflow:job:admission-error',
			}),
		);
		expect(connection.closed).toEqual({ code: 1011, reason: 'Workflow failed' });
	});

	it('normalizes an omitted workflow payload for recoverable admission', async () => {
		const connection = new TestConnection();
		const runStore = new InMemoryRunStore();
		connectCloudflareWorkflowWebSocket(connection, {
			name: 'job',
			runId: 'workflow:job:empty',
			requestUrl: 'https://example.com/workflows/job',
		});
		await messageCloudflareWorkflowWebSocket(
			connection,
			JSON.stringify({ version: 1, type: 'invoke', requestId: 'work-empty' }),
			{
				name: 'job',
				runId: 'workflow:job:empty',
				request: new Request('https://example.com/workflows/job'),
				handler: async (ctx) => ctx.payload,
				createContext,
				startWorkflowAdmission: async (_runId, run) => run(),
				runStore,
				runRegistry: new InMemoryRunRegistry(),
			},
		);

		expect(await runStore.getRun('workflow:job:empty')).toMatchObject({ payload: {}, result: {} });
		expect(connection.messages).toContainEqual(
			expect.objectContaining({ type: 'result', result: {} }),
		);
	});

	it('preserves an explicit null workflow payload', async () => {
		const connection = new TestConnection();
		const runStore = new InMemoryRunStore();
		connectCloudflareWorkflowWebSocket(connection, {
			name: 'job',
			runId: 'workflow:job:null',
			requestUrl: 'https://example.com/workflows/job',
		});
		await messageCloudflareWorkflowWebSocket(
			connection,
			JSON.stringify({ version: 1, type: 'invoke', requestId: 'work-null', payload: null }),
			{
				name: 'job',
				runId: 'workflow:job:null',
				request: new Request('https://example.com/workflows/job'),
				handler: async (ctx) => ctx.payload,
				createContext,
				startWorkflowAdmission: async (_runId, run) => run(),
				runStore,
				runRegistry: new InMemoryRunRegistry(),
			},
		);

		expect(await runStore.getRun('workflow:job:null')).toMatchObject({
			payload: null,
			result: null,
		});
		expect(connection.messages).toContainEqual(
			expect.objectContaining({ type: 'result', result: null }),
		);
	});

	it('does not send started or execute a workflow when durable admission persistence fails', async () => {
		const connection = new TestConnection();
		let admissions = 0;
		let executions = 0;
		connectCloudflareWorkflowWebSocket(connection, {
			name: 'job',
			runId: 'workflow:job:failed',
			requestUrl: 'https://example.com/workflows/job',
		});
		await messageCloudflareWorkflowWebSocket(
			connection,
			JSON.stringify({ version: 1, type: 'invoke', requestId: 'work-2', payload: { ok: true } }),
			{
				name: 'job',
				runId: 'workflow:job:failed',
				request: new Request('https://example.com/workflows/job'),
				handler: async () => {
					executions++;
					return null;
				},
				createContext,
				startWorkflowAdmission: async (_runId, run) => {
					admissions++;
					return run();
				},
				runStore: new FailingRunStore(),
				runRegistry: new InMemoryRunRegistry(),
			},
		);

		expect(admissions).toBe(0);
		expect(executions).toBe(0);
		expect(connection.messages.some((message) => message.type === 'started')).toBe(false);
		expect(connection.messages).toContainEqual(
			expect.objectContaining({ type: 'error', requestId: 'work-2', runId: 'workflow:job:failed' }),
		);
		expect(connection.closed).toEqual({ code: 1011, reason: 'Workflow failed' });
	});

	it('accepts one workflow invocation only', async () => {
		const connection = new TestConnection();
		let executions = 0;
		let release: (() => void) | undefined;
		connectCloudflareWorkflowWebSocket(connection, {
			name: 'job',
			runId: 'workflow:job:single',
			requestUrl: 'https://example.com/workflows/job',
		});
		const options = {
			name: 'job',
			runId: 'workflow:job:single',
			request: new Request('https://example.com/workflows/job'),
			handler: async () => {
				executions++;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return null;
			},
			createContext,
			startWorkflowAdmission: async (_runId: string, run: () => Promise<unknown>) => run(),
			runStore: new InMemoryRunStore(),
			runRegistry: new InMemoryRunRegistry(),
		};
		const first = messageCloudflareWorkflowWebSocket(
			connection,
			JSON.stringify({ version: 1, type: 'invoke', requestId: 'work-one' }),
			options,
		);
		await waitFor(() => release !== undefined);

		try {
			await messageCloudflareWorkflowWebSocket(
				connection,
				JSON.stringify({ version: 1, type: 'invoke', requestId: 'work-two' }),
				options,
			);

			expect(connection.messages).toContainEqual(
				expect.objectContaining({
					type: 'error',
					requestId: 'work-two',
					error: expect.objectContaining({ type: 'invalid_request' }),
				}),
			);
			expect(executions).toBe(1);
			expect(connection.closed).toEqual({
				code: 1008,
				reason: 'Workflow accepts one invocation only',
			});
		} finally {
			release?.();
			await first;
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

class TestConnection implements CloudflareWebSocketConnection {
	attachment = null as ReturnType<CloudflareWebSocketConnection['deserializeAttachment']>;
	messages: WebSocketServerMessage[] = [];
	closed: { code?: number; reason?: string } | undefined;
	rejectSends = false;

	serializeAttachment(attachment: NonNullable<typeof this.attachment>): void {
		this.attachment = attachment;
	}

	deserializeAttachment() {
		return this.attachment;
	}

	send(message: string): void {
		if (this.rejectSends) throw new Error('socket closed');
		this.messages.push(JSON.parse(message) as WebSocketServerMessage);
	}

	close(code?: number, reason?: string): void {
		this.closed = { code, reason };
	}
}

function agentOptions() {
	return {
		name: 'assistant',
		id: 'instance-1',
		request: new Request('https://example.com/agents/assistant/instance-1'),
		handler: async (ctx: { payload: unknown }) => ctx.payload,
		createContext,
		runStore: new InMemoryRunStore(),
		runRegistry: new InMemoryRunRegistry(),
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('Expected condition was not met.');
}

function createContext(id: string, runId: string | undefined, payload: unknown, req: Request) {
	return createFlueContext({
		id,
		runId,
		payload,
		env: {},
		req,
		agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
		createDefaultEnv: async () => ({}) as never,
		defaultStore: new InMemorySessionStore(),
	});
}
