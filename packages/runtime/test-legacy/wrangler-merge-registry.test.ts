import { describe, expect, it } from 'vitest';
import { mergeFlueAdditions } from '../../cli/src/lib/cloudflare-wrangler-merge.ts';

describe('mergeFlueAdditions', () => {
	it('appends FLUE_REGISTRY binding without disturbing user bindings', () => {
		const userConfig = {
			name: 'my-app',
			compatibility_date: '2026-04-01',
			compatibility_flags: ['nodejs_compat'],
			durable_objects: {
				bindings: [
					{ class_name: 'MyCustomDO', name: 'CUSTOM' },
					{ class_name: 'MySandbox', name: 'SANDBOX' },
				],
			},
		};
		const additions = {
			defaultName: 'fallback-name',
			main: '_entry.ts',
			doBindings: [
				{ class_name: 'Hello', name: 'Hello' },
				{ class_name: 'FlueRegistry', name: 'FLUE_REGISTRY' },
			],
		};
		const merged = mergeFlueAdditions(userConfig, additions) as {
			durable_objects: { bindings: Array<{ name: string; class_name: string }> };
		};

		const bindings = merged.durable_objects.bindings;
		expect(bindings.map((b) => b.name)).toEqual(['CUSTOM', 'SANDBOX', 'Hello', 'FLUE_REGISTRY']);
		const registry = bindings.find((b) => b.name === 'FLUE_REGISTRY');
		expect(registry?.class_name).toBe('FlueRegistry');
	});

	it('de-dupes FLUE_REGISTRY binding on second build', () => {
		const userConfig = {
			durable_objects: {
				bindings: [{ class_name: 'FlueRegistry', name: 'FLUE_REGISTRY' }],
			},
		};
		const additions = {
			defaultName: 'x',
			main: '_entry.ts',
			doBindings: [{ class_name: 'FlueRegistry', name: 'FLUE_REGISTRY' }],
		};
		const merged = mergeFlueAdditions(userConfig, additions) as {
			durable_objects: { bindings: unknown[] };
		};
		expect(merged.durable_objects.bindings).toHaveLength(1);
	});

	it('appends per-workflow DO bindings alongside agent bindings', () => {
		const additions = {
			defaultName: 'x',
			main: '_entry.ts',
			doBindings: [
				{ class_name: 'DraftWorkflow', name: 'FLUE_WORKFLOW_DRAFT' },
				{ class_name: 'DailyReportWorkflow', name: 'FLUE_WORKFLOW_DAILY_REPORT' },
			],
		};
		const merged = mergeFlueAdditions({}, additions) as {
			durable_objects: { bindings: Array<{ name: string; class_name: string }> };
		};
		expect(merged.durable_objects.bindings).toEqual([
			{ class_name: 'DraftWorkflow', name: 'FLUE_WORKFLOW_DRAFT' },
			{ class_name: 'DailyReportWorkflow', name: 'FLUE_WORKFLOW_DAILY_REPORT' },
		]);
	});

	it('rejects user-owned FLUE_REGISTRY binding conflicts', () => {
		const userConfig = {
			durable_objects: {
				bindings: [{ class_name: 'SomethingElse', name: 'FLUE_REGISTRY' }],
			},
		};
		const additions = {
			defaultName: 'x',
			main: '_entry.ts',
			doBindings: [{ class_name: 'FlueRegistry', name: 'FLUE_REGISTRY' }],
		};

		expect(() => mergeFlueAdditions(userConfig, additions)).toThrow(/FLUE_REGISTRY/);
	});

	it('preserves authored migrations without adding generated entries', () => {
		const migrations = [
			{ tag: 'v1', new_sqlite_classes: ['Hello', 'FlueRegistry'] },
			{ tag: 'v2', renamed_classes: [{ from: 'Hello', to: 'Support' }] },
		];
		const merged = mergeFlueAdditions(
			{ migrations },
			{
				defaultName: 'x',
				main: '_entry.ts',
				doBindings: [{ class_name: 'FlueRegistry', name: 'FLUE_REGISTRY' }],
			},
		);

		expect(merged.migrations).toBe(migrations);
	});

	it('does not create migrations when the user omitted them', () => {
		const merged = mergeFlueAdditions(
			{},
			{
				defaultName: 'x',
				main: '_entry.ts',
				doBindings: [{ class_name: 'FlueRegistry', name: 'FLUE_REGISTRY' }],
			},
		);

		expect(merged).not.toHaveProperty('migrations');
	});

	it('preserves named environments and their authored migrations', () => {
		const migrations = [{ tag: 'user-existing' }];
		const merged = mergeFlueAdditions(
			{
				name: 'support-seal-flue',
				env: { staging: { name: 'support-seal-flue-staging', migrations } },
			},
			{
				defaultName: 'x',
				main: '_entry.ts',
				doBindings: [{ class_name: 'FlueRegistry', name: 'FLUE_REGISTRY' }],
			},
		) as {
			name: string;
			env: {
				staging: {
					name: string;
					main: string;
					durable_objects: { bindings: Array<{ name: string }> };
					migrations: Array<{ tag: string }>;
				};
			};
		};

		expect(merged.name).toBe('support-seal-flue');
		expect(merged.env.staging.name).toBe('support-seal-flue-staging');
		expect(merged.env.staging.main).toBe('_entry.ts');
		expect(merged.env.staging.durable_objects.bindings.map((binding) => binding.name)).toContain(
			'FLUE_REGISTRY',
		);
		expect(merged.env.staging.migrations).toBe(migrations);
	});
});
