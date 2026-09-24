import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import test from "node:test";

// Link the real extension source to inert SDK doubles. No browser, credentials,
// PDF parser or external request is used in these boundary checks.
async function load(relative, extraExports, overrides = {}, mocks = {}) {
	const url = new URL(relative, import.meta.url);
	const context = vm.createContext({ console, URL, AbortController, AbortSignal, setTimeout, clearTimeout, TextDecoder, Uint8Array, Response, process: { env: {} }, ...overrides });
	const source = stripTypeScriptTypes(readFileSync(url, "utf8")) + `\nexport { ${extraExports} };`;
	const module = new vm.SourceTextModule(source, { context, initializeImportMeta(meta) { meta.url = url.href; } });
	const defaults = {
		typebox: { Type: new Proxy({}, { get: () => () => ({}) }) },
		"@earendil-works/pi-tui": { Text: class {} },
		"@mozilla/readability": { Readability: class {} },
		linkedom: { parseHTML() { throw new Error("HTML parsing is outside this test"); } },
		turndown: { default: class {} },
	};
	await module.link(async name => {
		const exports = mocks[name] ?? defaults[name] ?? (name.startsWith("node:") ? await import(name) : null);
		assert.ok(exports, `Unexpected dependency: ${name}`);
		return new vm.SyntheticModule(Object.keys(exports), function () {
			for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
		}, { context });
	});
	await module.evaluate();
	return module.namespace;
}

test("streamed bodies enforce the limit without trusting Content-Length", async () => {
	for (const contentType of ["text/plain", "application/pdf"]) {
		for (const length of [undefined, "1"]) {
			let cancelled = false;
			let reads = 0;
			const body = new ReadableStream({
				pull(controller) { reads++; if (reads > 24) controller.close(); else controller.enqueue(new Uint8Array(1024 * 1024)); },
				cancel() { cancelled = true; },
			});
			const headers = { "content-type": contentType, ...(length ? { "content-length": length } : {}) };
			const module = await load("../extensions/web-fetch/index.ts", "extractViaHttp", { fetch: async () => new Response(body, { headers }) });
			const result = await module.extractViaHttp("https://example.com/fabricated");
			assert.match(result.error ?? "", /Response too large/);
			assert.equal(cancelled, true);
			assert.ok(reads <= (contentType === "text/plain" ? 7 : 22));
		}
	}
	const module = await load("../extensions/web-fetch/index.ts", "extractViaHttp", { fetch: async () => new Response("fabricated text", { headers: { "content-type": "text/plain" } }) });
	assert.equal((await module.extractViaHttp("https://example.com/fabricated")).content, "fabricated text");
});

test("search count stays within API bounds", async () => {
	let requested;
	const module = await load("../extensions/web-search/index.ts", "googleSearch", { fetch: async url => { requested = new URL(url); return new Response('{"items":[]}'); } });
	for (const [input, expected] of [[-5, 1], [0, 1], [5, 5], [20, 10], [2.9, 2], [NaN, 5], [Infinity, 5]]) {
		await module.googleSearch("fabricated query", input, "fabricated", "fabricated");
		assert.equal(requested.searchParams.get("num"), String(expected));
	}
});

test("network details expose only the opted-in headers", async () => {
	const handlers = new Map();
	const page = { on: (name, handler) => handlers.set(name, handler), isClosed: () => false, goto: async () => ({ status: () => 200 }), url: () => "https://example.com/" };
	const module = await load("../extensions/browser/index.ts", "filterHeaders", {}, { "playwright-core": { chromium: { launchPersistentContext: async () => ({ pages: () => [page] }) } } });
	const tools = new Map();
	module.default({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on() {}, getActiveTools: () => [], setActiveTools() {} });
	await tools.get("browser_goto").execute("", { url: "https://example.com/" });
	await handlers.get("requestfinished")({ method: () => "GET", url: () => "https://example.com/", resourceType: () => "fetch", headers: () => ({ authorization: "fabricated", origin: "https://fabricated.example", cookie: "fabricated-cookie", "content-type": "text/plain" }), response: async () => ({ status: () => 200, statusText: () => "OK", headers: () => ({ "set-cookie": "fabricated-response", "content-type": "text/plain" }) }) });
	for (const params of [{}, { verbose: true }, { includeHeaders: ["cookie"] }]) {
		const result = await tools.get("browser_network").execute("", { ...params, clear: false });
		const entry = result.details.entries[0];
		assert.equal(entry.method, "GET");
		assert.equal(entry.requestHeaders?.authorization, params.verbose || params.includeHeaders ? "fabricated" : undefined);
		// origin is in the curated allowlist, matching the guideline text that promises it.
		assert.equal(entry.requestHeaders?.origin, params.verbose || params.includeHeaders ? "https://fabricated.example" : undefined);
		assert.equal(entry.requestHeaders?.cookie, params.includeHeaders ? "fabricated-cookie" : undefined);
		assert.equal(entry.responseHeaders?.["set-cookie"], undefined);
	}
});

test("browser_eval renders undefined and null as distinct text", async () => {
	// The guide said an undefined result becomes null. JSON.stringify produces
	// nothing for undefined, so the renderer falls back to String(result) and
	// the two are distinguishable.
	let value;
	const page = { on: () => {}, isClosed: () => false, goto: async () => ({ status: () => 200 }), url: () => "https://example.com/", evaluate: async () => value };
	const module = await load("../extensions/browser/index.ts", "filterHeaders", {}, { "playwright-core": { chromium: { launchPersistentContext: async () => ({ pages: () => [page] }) } } });
	const tools = new Map();
	module.default({ registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, on() {}, getActiveTools: () => [], setActiveTools() {} });
	await tools.get("browser_goto").execute("", { url: "https://example.com/" });
	for (const [result, expected] of [[undefined, "undefined"], [null, "null"], [42, "42"], ["plain string", "plain string"]]) {
		value = result;
		const out = await tools.get("browser_eval").execute("", { expression: "fabricated" });
		assert.equal(out.content[0].text, expected);
	}
});


test("Jina preserves fragment routes and keeps ordinary GET requests", async () => {
    const calls = [];
    const module = await load("../extensions/web-fetch/index.ts", "extractWithJinaReader,isPrivateHost", {
        fetch: async (url, options) => {
            calls.push({ url, options });
            return new Response("Markdown Content:\n# Synthetic\n" + "Synthetic content. ".repeat(20));
        },
    });
    const target = "https://example.com/#/invoices?period=2026";
    const result = await module.extractWithJinaReader(target);
    assert.equal(result.url, target);
    assert.equal(calls[0].url, "https://r.jina.ai/");
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), { url: target });
    assert.equal(calls[0].options.headers["Content-Type"], "application/json");
    await module.extractWithJinaReader("https://example.com/invoices");
    assert.equal(calls[1].url, "https://r.jina.ai/https://example.com/invoices");
    assert.equal(calls[1].options.method, undefined);
    assert.ok(calls[0].options.signal);
    for (const privateUrl of [
        "http://127.0.0.1/#/payroll",
        "http://[::1]/#/payroll",
        "http://10.0.0.1/#/payroll",
        // Both IPv4-in-IPv6 spellings of loopback. ::a.b.c.d is the deprecated IPv4-compatible
        // form and used to miss the mapped-address branch, so the URL reached r.jina.ai.
        "http://[::ffff:127.0.0.1]/#/payroll",
        "http://[::127.0.0.1]/#/payroll",
        "http://[::ffff:10.0.0.1]/#/payroll",
        "http://[::10.0.0.1]/#/payroll",
    ]) {
        assert.equal(await module.isPrivateHost(privateUrl), true, privateUrl);
    }
    assert.equal(await module.isPrivateHost("http://[2001:db8::1]/#/payroll"), false);
});

test("Jina fragment responses retain the body-size limit", async () => {
    const module = await load("../extensions/web-fetch/index.ts", "extractWithJinaReader", {
        fetch: async () => new Response("x".repeat(6 * 1024 * 1024)),
    });
    assert.equal(await module.extractWithJinaReader("https://example.com/#/invoices"), null);
});

test("a queued call cannot relaunch the browser after /browser off", async () => {
	let launches = 0;
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const page = {
		on: () => {},
		isClosed: () => false,
		url: () => "https://example.com/",
		goto: async () => { await gate; return { status: () => 200 }; },
	};
	const module = await load("../extensions/browser/index.ts", "filterHeaders", {}, {
		"playwright-core": { chromium: { launchPersistentContext: async () => { launches++; return { pages: () => [page], close: async () => {} }; } } },
	});
	const tools = new Map();
	const commands = new Map();
	module.default({
		registerTool: tool => tools.set(tool.name, tool),
		registerCommand: (name, cfg) => commands.set(name, cfg),
		on() {},
		getActiveTools: () => [],
		setActiveTools() {},
		appendEntry: () => {},
	});
	// First goto takes the queue and hangs inside the mocked page.goto.
	const first = tools.get("browser_goto").execute("", { url: "https://example.com/" });
	await new Promise(resolve => setTimeout(resolve, 0));
	// /browser off queues the teardown behind the in-flight goto; a straggler
	// goto queues behind the teardown. Neither may relaunch Chromium after it.
	const off = commands.get("browser").handler("off", { ui: { notify() {} } });
	const second = tools.get("browser_goto").execute("", { url: "https://example.com/" });
	await new Promise(resolve => setTimeout(resolve, 0));
	release();
	await first;
	await assert.rejects(second, /disabled or shutting down/);
	await off;
	assert.equal(launches, 1);
	// /browser on clears the gate and a later call relaunches exactly once.
	await commands.get("browser").handler("on", { ui: { notify() {} } });
	await tools.get("browser_goto").execute("", { url: "https://example.com/" });
	assert.equal(launches, 2);
});

test("the private-host guard classifies range edges and resolved names", async () => {
	const answers = {
		"payroll.corp.example": [{ address: "192.168.4.20", family: 4 }],
		"mixed.example": [{ address: "93.184.216.34", family: 4 }, { address: "fd00::1", family: 6 }],
		"public.example": [{ address: "93.184.216.34", family: 4 }],
		"empty.example": [],
	};
	const lookup = async host => {
		if (host in answers) return answers[host];
		throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
	};
	const module = await load("../extensions/web-fetch/index.ts", "isPrivateHost", {}, {
		"node:dns": { promises: { lookup } },
	});
	const expected = {
		"http://0.0.0.0:8080/": true,
		"http://172.15.255.255/": false,
		"http://172.16.0.1/": true,
		"http://172.31.255.255/": true,
		"http://172.32.0.1/": false,
		"http://192.168.1.1/": true,
		"http://169.254.169.254/latest/meta-data/": true,
		"http://[::]/": true,
		"http://[fe80::1]/": true,
		"http://[febf::1]/": true,
		"http://[fec0::1]/": false,
		"http://[fc00::1]/": true,
		"http://[fdff::1]/": true,
		"http://[::ffff:7f00:1]/": true,
		"http://localhost:3000/": true,
		"http://app.localhost/": true,
		"http://printer.local/": true,
		"http://payroll.corp.example/": true,
		"http://mixed.example/": true,
		"http://empty.example/": true,
		"http://unresolvable.example/": true,
		"http://public.example/": false,
		"not a url": true,
	};
	for (const [url, isPrivate] of Object.entries(expected)) {
		assert.equal(await module.isPrivateHost(url), isPrivate, url);
	}
});
