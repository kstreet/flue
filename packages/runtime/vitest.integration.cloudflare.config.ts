import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test-legacy/vite-cloudflare-build.test.ts'],
	},
});
