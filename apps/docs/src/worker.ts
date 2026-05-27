interface Env {
	ASSETS: {
		fetch(request: Request): Promise<Response>;
	};
}

function isMarkdownRequest(request: Request, url: URL) {
	return (request.method === 'GET' || request.method === 'HEAD') && url.pathname.endsWith('/index.md');
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (!isMarkdownRequest(request, url)) {
			return env.ASSETS.fetch(request);
		}

		url.pathname = url.pathname.slice(0, -'index.md'.length);
		const headers = new Headers(request.headers);
		headers.set('Accept', 'text/markdown');

		return fetch(new Request(url, { method: request.method, headers }));
	},
};
