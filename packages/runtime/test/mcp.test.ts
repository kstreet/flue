import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectMcpServer } from '../src/index.ts';

const mcp = vi.hoisted(() => ({
	clients: [] as Array<{
		callTool: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
		connect: ReturnType<typeof vi.fn>;
		listTools: ReturnType<typeof vi.fn>;
	}>,
	connectError: undefined as Error | undefined,
	listToolsError: undefined as Error | undefined,
	listToolsResults: [] as Array<{ tools: unknown[]; nextCursor?: string }>,
	listToolsResult: { tools: [] } as { tools: unknown[]; nextCursor?: string },
	callToolResult: { content: [] } as unknown,
}));

// TODO(RUNTIME-20): Replace this temporary whole-module mock with an internal MCP adapter boundary and a lightweight local integration fixture.
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
	Client: class {
		callTool = vi.fn(async () => mcp.callToolResult);
		close = vi.fn(async () => {});
		connect = vi.fn(async () => {
			if (mcp.connectError) throw mcp.connectError;
		});
		listTools = vi.fn(async () => {
			if (mcp.listToolsError) throw mcp.listToolsError;
			return mcp.listToolsResults.shift() ?? mcp.listToolsResult;
		});

		constructor() {
			mcp.clients.push(this);
		}
	},
}));

beforeEach(() => {
	mcp.clients.length = 0;
	mcp.connectError = undefined;
	mcp.listToolsError = undefined;
	mcp.listToolsResults.length = 0;
	mcp.listToolsResult = { tools: [] };
	mcp.callToolResult = { content: [] };
});

describe('connectMcpServer()', () => {
	it('exposes listed MCP tools as Flue tools when a server connection succeeds', async () => {
		mcp.listToolsResult = {
			tools: [
				{
					name: 'lookup',
					description: 'Find a catalog entry.',
					inputSchema: {
						type: 'object',
						properties: { query: { type: 'string' } },
						required: ['query'],
					},
				},
			],
		};

		const connection = await connectMcpServer('catalog', { url: 'https://mcp.example.test' });

		expect(connection.name).toBe('catalog');
		expect(connection.tools).toEqual([
			expect.objectContaining({
				name: 'mcp__catalog__lookup',
				description: expect.stringContaining('Find a catalog entry.'),
				parameters: {
					type: 'object',
					properties: { query: { type: 'string' } },
					required: ['query'],
				},
				execute: expect.any(Function),
			}),
		]);
	});

	it('exposes tools from every tools/list page when MCP discovery is paginated', async () => {
		mcp.listToolsResults = [
			{
				tools: [
					{
						name: 'lookup',
						inputSchema: { type: 'object' },
					},
				],
				nextCursor: 'catalog-page-2',
			},
			{
				tools: [
					{
						name: 'refresh',
						inputSchema: { type: 'object' },
					},
				],
				nextCursor: '',
			},
			{
				tools: [
					{
						name: 'inspect',
						inputSchema: { type: 'object' },
					},
				],
			},
		];

		const connection = await connectMcpServer('catalog', { url: 'https://mcp.example.test' });

		expect(connection.tools.map((tool) => tool.name)).toEqual([
			'mcp__catalog__lookup',
			'mcp__catalog__refresh',
			'mcp__catalog__inspect',
		]);
		expect(mcp.clients[0]?.listTools).toHaveBeenNthCalledWith(1);
		expect(mcp.clients[0]?.listTools).toHaveBeenNthCalledWith(2, { cursor: 'catalog-page-2' });
		expect(mcp.clients[0]?.listTools).toHaveBeenNthCalledWith(3, { cursor: '' });
	});

	it('namespaces and sanitizes tool names when server or tool names contain unsupported characters', async () => {
		mcp.listToolsResult = {
			tools: [
				{
					name: ' find.value ',
					inputSchema: { type: 'object' },
				},
			],
		};

		const connection = await connectMcpServer(' docs/API ', { url: 'https://mcp.example.test' });

		expect(connection.tools[0]?.name).toBe('mcp__docs_API__find_value');
	});

	it('rejects adapted tools when sanitization produces duplicate names across pages', async () => {
		mcp.listToolsResults = [
			{
				tools: [
					{
						name: 'read/value',
						inputSchema: { type: 'object' },
					},
				],
				nextCursor: 'catalog-page-2',
			},
			{
				tools: [
					{
						name: 'read value',
						inputSchema: { type: 'object' },
					},
				],
			},
		];

		await expect(connectMcpServer('catalog', { url: 'https://mcp.example.test' })).rejects.toThrow(
			'[flue] MCP tools from server "catalog" produced duplicate tool name "mcp__catalog__read_value".',
		);
		expect(mcp.clients[0]?.close).toHaveBeenCalledOnce();
	});

	it('returns a usable object parameter schema when an MCP tool omits optional object schema fields', async () => {
		mcp.listToolsResult = {
			tools: [
				{
					name: 'refresh',
					inputSchema: { type: 'object' },
				},
			],
		};

		const connection = await connectMcpServer('cache', { url: 'https://mcp.example.test' });

		expect(connection.tools[0]?.parameters).toEqual({
			type: 'object',
			properties: {},
			required: undefined,
		});
	});

	it('forwards arguments and abort signals when an adapted MCP tool executes', async () => {
		mcp.listToolsResult = {
			tools: [
				{
					name: 'lookup',
					inputSchema: {
						type: 'object',
						properties: { query: { type: 'string' } },
						required: ['query'],
					},
				},
			],
		};
		mcp.callToolResult = { content: [{ type: 'text', text: 'Found.' }] };
		const controller = new AbortController();
		const connection = await connectMcpServer('catalog', { url: 'https://mcp.example.test' });

		await connection.tools[0]?.execute({ query: 'flue' }, controller.signal);

		expect(mcp.clients[0]?.callTool).toHaveBeenCalledWith(
			{
				name: 'lookup',
				arguments: { query: 'flue' },
			},
			undefined,
			{ signal: controller.signal },
		);
	});

	it("preserves supported MCP content in the adapted tool's readable text result when an MCP tool returns mixed content", async () => {
		mcp.listToolsResult = {
			tools: [
				{
					name: 'inspect',
					inputSchema: { type: 'object' },
				},
			],
		};
		mcp.callToolResult = {
			structuredContent: { count: 2 },
			content: [
				{ type: 'text', text: 'Inspection complete.' },
				{ type: 'image', mimeType: 'image/png', data: 'YWJj' },
				{ type: 'audio', mimeType: 'audio/wav', data: 'ZGVmZw==' },
				{ type: 'resource', resource: { uri: 'file:///report.txt', text: 'Report text.' } },
				{ type: 'resource', resource: { uri: 'file:///archive.zip', blob: 'aGk=' } },
				{
					type: 'resource_link',
					name: 'details',
					uri: 'https://mcp.example.test/details',
					description: 'Full details',
				},
			],
		};
		const connection = await connectMcpServer('catalog', { url: 'https://mcp.example.test' });

		const result = await connection.tools[0]?.execute({});

		expect(result).toContain('"count": 2');
		expect(result).toContain('Inspection complete.');
		expect(result).toContain('image/png');
		expect(result).toContain('audio/wav');
		expect(result).toContain('file:///report.txt');
		expect(result).toContain('Report text.');
		expect(result).toContain('file:///archive.zip');
		expect(result).toContain('details');
		expect(result).toContain('https://mcp.example.test/details');
		expect(result).toContain('Full details');
	});

	it('throws tool output as an error when an MCP result marks itself as an error', async () => {
		mcp.listToolsResult = {
			tools: [
				{
					name: 'lookup',
					inputSchema: { type: 'object' },
				},
			],
		};
		mcp.callToolResult = {
			content: [{ type: 'text', text: 'Catalog unavailable.' }],
			isError: true,
		};
		const connection = await connectMcpServer('catalog', { url: 'https://mcp.example.test' });

		await expect(connection.tools[0]?.execute({})).rejects.toThrow('Catalog unavailable.');
	});

	it('closes the MCP client when connection setup fails', async () => {
		mcp.listToolsError = new Error('Tool discovery failed.');

		await expect(connectMcpServer('catalog', { url: 'https://mcp.example.test' })).rejects.toThrow(
			'Tool discovery failed.',
		);
		expect(mcp.clients[0]?.close).toHaveBeenCalledOnce();
	});

	it('closes the MCP client when the returned connection is closed', async () => {
		const connection = await connectMcpServer('catalog', { url: 'https://mcp.example.test' });

		await connection.close();

		expect(mcp.clients[0]?.close).toHaveBeenCalledOnce();
	});
});
