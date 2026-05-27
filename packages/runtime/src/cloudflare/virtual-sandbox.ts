/** Deprecated compatibility stub for the removed virtual Cloudflare sandbox API. */

export interface VirtualSandboxOptions {
	prefix?: string;
}

export function getVirtualSandbox(): never;
export function getVirtualSandbox(bucket: unknown, options?: VirtualSandboxOptions): never;
export function getVirtualSandbox(bucket?: unknown, _options?: VirtualSandboxOptions): never {
	if (bucket === undefined) {
		throw new Error(
			'[flue] getVirtualSandbox() has been removed. Flue\'s default in-memory sandbox is already ' +
				'what you wanted — omit the `sandbox` field from createAgent(...) (or pass `false`) and you get it.',
		);
	}
	throw new Error(
		'[flue] getVirtualSandbox(bucket) has been removed because R2 is not a live mounted agent filesystem. ' +
			'Run `flue add @cloudflare/shell`, import `getShellSandbox` and `hydrateFromBucket` from your generated ' +
			'`connectors/cloudflare-shell` file, hydrate the workspace, then pass `sandbox: getShellSandbox(...)` ' +
			'to createAgent().',
	);
}
