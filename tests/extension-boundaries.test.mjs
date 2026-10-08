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

test("HTML tag stripping preserves empty and unclosed tags", async () => {
	const module = await load("../extensions/web-fetch/index.ts", "stripHtmlTags,isLikelyJSRendered");
	for (const [input, expected] of [
		["plain > text", "plain > text"],
		["<>text<>", "<>text<>"],
		["<b>text</b><unfinished", "text<unfinished"],
		["<<b>>tail", ">tail"],
		["<\n>text", "text"],
		["<".repeat(50_000), "<".repeat(50_000)],
		["<".repeat(50_000) + ">", ""],
	]) assert.equal(module.stripHtmlTags(input), expected);
	assert.equal(module.isLikelyJSRendered("<script></script>".repeat(4) + "<body>short</body>"), true);
	assert.equal(module.isLikelyJSRendered("<script></script>".repeat(4) + "<body>" + "<".repeat(50_000) + "</body>"), false);
});

test("site normalisation preserves long invalid input and trims slash runs", async () => {
	const module = await load("../extensions/web-search/index.ts", "normalizeSite");
	const invalid = "/".repeat(50_000) + "%";
	assert.equal(module.normalizeSite(invalid), invalid);
	assert.equal(module.normalizeSite("%" + "/".repeat(50_000)), "%");
});

test("snippet metadata preserves leading separators and rejects embedded separators", async () => {
	const unused = () => { throw new Error("UI is outside this test"); };
	const module = await load("../extensions/prompt-snippets/index.ts", "parseSnippet", {}, {
		"@earendil-works/pi-tui": { Key: {}, matchesKey: unused, truncateToWidth: unused, wrapTextWithAnsi: unused },
	});
	for (const [value, expected] of [
		["\u2028Synthetic", "Synthetic"],
		["trailing\u2029", "sample"],
		["first\u2028second", "sample"],
		[" ".repeat(50_000) + "first\u2029second", "sample"],
	]) {
		const parsed = module.parseSnippet("sample.md", `---\nname: ${value}\nplacement: append\norder: 2\n---\nSynthetic body`);
		assert.equal(parsed.name, expected);
		assert.equal(parsed.placement, "append");
		assert.equal(parsed.order, 2);
	}
});

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
		"http://100.63.255.255/": false,
		"http://100.64.0.1/": true,
		"http://100.127.255.255/": true,
		"http://100.128.0.1/": false,
		"http://198.17.255.255/": false,
		"http://198.18.0.1/": true,
		"http://198.19.255.255/": true,
		"http://198.20.0.1/": false,
		"http://[64:ff9b::7f00:1]/": true,
		"http://[2002:7f00:1::]/": true,
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

test("search query construction quotes, excludes and scopes sites", async () => {
	const module = await load("../extensions/web-search/index.ts", "buildSearchQuery,cleanQuery,cleanItems,stripWrappingQuotes,normalizeSite,quoteForSearch");
	assert.equal(module.cleanQuery(undefined), undefined);
	assert.equal(module.cleanQuery(123), undefined);
	assert.equal(module.cleanQuery("   "), undefined);
	assert.equal(module.cleanQuery("  payroll\n close "), "payroll close");
	assert.equal(module.stripWrappingQuotes('"quoted"'), "quoted");
	assert.equal(module.stripWrappingQuotes("plain"), "plain");
	assert.equal(module.stripWrappingQuotes('"'), '"');
	assert.deepEqual(module.cleanItems(["  two   words ", '"kept phrase"', '""', ""]), ["two words", "kept phrase"]);
	assert.equal(module.normalizeSite("site:Example.com/path"), "example.com");
	assert.equal(module.normalizeSite("https://sub.example.co.uk/deep/path"), "sub.example.co.uk");
	assert.equal(module.normalizeSite("example.com///"), "example.com");
	assert.equal(module.normalizeSite("  "), undefined);
	assert.equal(module.normalizeSite("not a url"), "not a url");
	assert.equal(module.quoteForSearch('say "hi"'), '"say \\"hi\\""');

	assert.throws(() => module.buildSearchQuery({}), /At least one of 'query' or 'exactPhrases'/);
	assert.throws(() => module.buildSearchQuery({ query: "  " }), /At least one of 'query' or 'exactPhrases'/);
	const built = module.buildSearchQuery({
		query: "  payroll   close ",
		exactPhrases: ['"lodgment 2026"'],
		excludeTerms: ["draft report", "noise"],
		site: "site:ato.gov.au",
	});
	assert.equal(built.query, 'payroll close "lodgment 2026" -"draft report" -noise site:ato.gov.au');
	assert.equal(built.baseQuery, "payroll close");
	assert.deepEqual(built.exactPhrases, ["lodgment 2026"]);
	assert.deepEqual(built.excludeTerms, ["draft report", "noise"]);
	assert.equal(built.site, "ato.gov.au");
	// exactPhrases alone satisfies the requirement, and phrases are re-quoted
	// even when the caller already wrapped them in quote marks.
	assert.equal(module.buildSearchQuery({ exactPhrases: ['one "two"'] }).query, '"one \\"two\\""');
});

test("snippet parsing rejects malformed files and defaults the metadata", async () => {
	const module = await load("../extensions/prompt-snippets/index.ts", "parseSnippet", {}, {
		"@earendil-works/pi-tui": { Text: class {}, Key: {}, matchesKey: () => false, truncateToWidth: (s) => s, wrapTextWithAnsi: (s) => s },
	});
	assert.equal(module.parseSnippet("plain.md", "no frontmatter"), null);
	assert.equal(module.parseSnippet("empty.md", "---\nname: x\n---\n   \n"), null);
	assert.deepEqual(
		{ ...module.parseSnippet("rules.md", '---\nName: "Concise"\ndescription: Short   form\nplacement: prepend\norder: 3\n---\n  Body text.  \n') },
		{ id: "rules.md", name: "Concise", description: "Short   form", placement: "prepend", order: 3, body: "Body text." },
	);
	assert.deepEqual(
		{ ...module.parseSnippet("fallback.md", "---\nplacement: later\norder: fabricated\n---\nbody") },
		{ id: "fallback.md", name: "fallback", description: "", placement: "append", order: 9999, body: "body" },
	);
	assert.equal(module.parseSnippet("crlf.md", "---\r\nname: crlf\r\n---\r\nbody text").body, "body text");
});

test("browser buffers stay bounded and header filtering honours the allowlist", async () => {
	const module = await load("../extensions/browser/index.ts", "pushBounded,filterHeaders", {}, {
		"playwright-core": { chromium: { launchPersistentContext: async () => ({ pages: () => [] }) } },
	});
	const buf = [];
	for (let i = 0; i < 1005; i++) module.pushBounded(buf, i);
	assert.equal(buf.length, 1000);
	assert.equal(buf[0], 5);
	assert.equal(buf[999], 1004);
	assert.deepEqual(
		{ ...module.filterHeaders(
			{ "Content-Type": "text/plain", cookie: "fabricated", Authorization: "fabricated", origin: "https://fabricated.example" },
			new Set(["content-type", "origin"]),
		) },
		{ "Content-Type": "text/plain", origin: "https://fabricated.example" },
	);
});

test("serialised calls run one at a time and a rejection does not poison the queue", async () => {
	const module = await load("../extensions/browser/index.ts", "serialize", {}, {
		"playwright-core": { chromium: { launchPersistentContext: async () => ({ pages: () => [] }) } },
	});
	const order = [];
	const first = module.serialize(async () => {
		order.push("start:1");
		await new Promise((resolve) => setTimeout(resolve, 20));
		order.push("end:1");
		return 1;
	});
	const second = module.serialize(async () => {
		order.push("start:2");
		return 2;
	});
	assert.equal(await first, 1);
	assert.equal(await second, 2);
	assert.deepEqual(order, ["start:1", "end:1", "start:2"]);
	await assert.rejects(module.serialize(async () => { throw new Error("fabricated failure"); }), /fabricated failure/);
	assert.equal(await module.serialize(async () => 3), 3);
});
