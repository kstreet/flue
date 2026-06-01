import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test-legacy/packed-copy-release.test.ts'],
	},
});
