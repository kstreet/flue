import { Type } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { createAgent, defineAgentProfile, resolveAgentProfile } from '../src/agent-definition.ts';
import { defineTool } from '../src/tool.ts';

describe('defineAgentProfile', () => {
	it('returns the provided agent definition', () => {
		const tool = defineTool({
			name: 'lookup',
			description: 'Look up a value.',
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => 'ok',
		});
		const definition = {
			model: 'anthropic/claude-sonnet-4-6',
			instructions: 'Help the user.',
			skills: [{ name: 'triage', description: 'Triage requests.' }],
			tools: [tool],
			subagents: [{ name: 'delegate', model: false as const }],
		};

		expect(defineAgentProfile(definition)).toBe(definition);
	});

	it('accepts an empty definition', () => {
		const definition = {};

		expect(defineAgentProfile(definition)).toBe(definition);
	});

	it.each([
		[{ model: 123 }, 'valid agent profile'],
		[{ instructions: false }, 'valid agent profile'],
		[{ thinkingLevel: 'turbo' }, 'thinkingLevel'],
		[{ compaction: { reserveTokens: 'lots' } }, 'compaction.reserveTokens'],
		[{ compaction: { reserveTokens: -1 } }, 'non-negative integer'],
		[{ compaction: { reserveTokens: Number.NaN } }, 'non-negative integer'],
		[{ compaction: { keepRecentTokens: Number.POSITIVE_INFINITY } }, 'non-negative integer'],
		[{ compaction: { keepRecentTokens: 1.5 } }, 'non-negative integer'],
		[{ instruction: 'Typo.' }, 'unknown agent profile field'],
		[{ skills: [{ description: 'Missing name.' }] }, 'skills[0].name'],
		[{ skills: [{ name: ' ', description: 'Blank name.' }] }, 'skills[0].name'],
		[{ skills: [{ name: 'triage' }] }, 'skills[0].description'],
		[{ tools: [{ name: 123 }] }, 'tools[0].name'],
		[
			{
				tools: [
					{
						name: ' ',
						description: 'Desc',
						parameters: {},
						execute: async (): Promise<string> => 'ok',
					},
				],
			},
			'tools[0].name',
		],
		[
			{ tools: [{ name: 'tool', parameters: {}, execute: async (): Promise<string> => 'ok' }] },
			'tools[0].description',
		],
		[
			{
				tools: [{ name: 'tool', description: 'Desc', execute: async (): Promise<string> => 'ok' }],
			},
			'tools[0].parameters',
		],
		[{ tools: [{ name: 'tool', description: 'Desc', parameters: {} }] }, 'tools[0].execute'],
		[{ subagents: [{ model: 123 }] }, 'subagents[0].name'],
		[{ subagents: [{ name: '1bad', model: false }] }, 'must start with a letter'],
	])('rejects invalid definitions %#', (definition, message) => {
		expect(() => defineAgentProfile(definition as never)).toThrow(String(message));
	});

	it('rejects duplicate tool names', () => {
		const tool = {
			name: 'lookup',
			description: 'Look up a value.',
			parameters: {},
			execute: async () => 'ok',
		};

		expect(() => defineAgentProfile({ tools: [tool, tool] })).toThrow(
			'duplicate tool name "lookup"',
		);
	});

	it('rejects duplicate skill names', () => {
		expect(() =>
			defineAgentProfile({
				skills: [
					{ name: 'triage', description: 'Triage requests.' },
					{ name: 'triage', description: 'Triage other requests.' },
				],
			}),
		).toThrow('duplicate skill name "triage"');
	});

	it('rejects circular subagents', () => {
		const definition = { name: 'loop' } as { name: string; subagents?: unknown[] };
		definition.subagents = [definition];

		expect(() => defineAgentProfile(definition as never)).toThrow('circular subagents');
	});

	it('creates an opaque runtime-initializable agent', async () => {
		const agent = createAgent(({ id, payload }) => ({
			model: false,
			instructions: `${id}:${String(payload)}`,
		}));
		expect(agent.__flueCreatedAgent).toBe(true);
		expect(await agent.initialize({ id: 'instance', env: {}, payload: undefined })).toMatchObject({
			model: false,
		});
	});

	it('rejects unknown created-agent runtime config fields during resolution', () => {
		expect(() => resolveAgentProfile({ model: false, typo: true } as never)).toThrow(
			'unknown runtime config field "typo"',
		);
	});
});

describe('resolveAgentProfile', () => {
	it('inherits scalar fields and appends created-agent capabilities to its profile', () => {
		const inheritedSkill = { name: 'base', description: 'Base skill.' };
		const runtimeSkill = { name: 'runtime', description: 'Runtime skill.' };
		const inheritedTool = defineTool({
			name: 'base_tool',
			description: 'Base tool.',
			parameters: {},
			execute: async () => 'base',
		});
		const runtimeTool = defineTool({
			name: 'runtime_tool',
			description: 'Runtime tool.',
			parameters: {},
			execute: async () => 'runtime',
		});
		const inheritedSubagent = { name: 'base_agent', model: false as const };
		const runtimeSubagent = { name: 'runtime_agent', model: false as const };
		expect(
			resolveAgentProfile({
				profile: {
					model: 'anthropic/claude-sonnet-4-6',
					instructions: 'Inherited instructions.',
					skills: [inheritedSkill],
					tools: [inheritedTool],
					subagents: [inheritedSubagent],
				},
				instructions: undefined,
				skills: [runtimeSkill],
				tools: [runtimeTool],
				subagents: [runtimeSubagent],
			}),
		).toEqual({
			name: undefined,
			description: undefined,
			model: 'anthropic/claude-sonnet-4-6',
			instructions: undefined,
			skills: [inheritedSkill, runtimeSkill],
			tools: [inheritedTool, runtimeTool],
			subagents: [inheritedSubagent, runtimeSubagent],
			thinkingLevel: undefined,
			compaction: undefined,
		});
	});
});
