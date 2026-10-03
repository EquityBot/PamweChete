import assert from "node:assert/strict";
import { createServer } from "node:http";

export async function budgetProxy({ modelId, contextWindow, maxTokens, pricing, maxRequests, maxEstimatedUsd, upstream = "https://api.featherless.ai/v1", fetcher = fetch }) {
 assert.ok(Number.isInteger(maxRequests) && maxRequests > 0 && maxRequests <= 10000, "Invalid request budget");
 assert.ok(Number.isFinite(maxEstimatedUsd) && maxEstimatedUsd > 0, "A positive estimated spending limit is required");
 assert.ok([pricing.input, pricing.output].every(n => Number.isFinite(n) && n >= 0), "Current prices are required");
 assert.ok([contextWindow, maxTokens].every(n => Number.isSafeInteger(n) && n > 0) && maxTokens < contextWindow, "Invalid token ceilings");
 const endpoint = new URL(upstream);
 assert.ok(upstream === "https://api.featherless.ai/v1" || (endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1" && endpoint.pathname === "/v1" && !endpoint.username && !endpoint.password), "Unexpected upstream endpoint");
 const reservationMicros = Math.ceil(contextWindow * pricing.input + maxTokens * pricing.output);
 const budgetMicros = Math.floor(maxEstimatedUsd * 1_000_000);
 assert.ok(Number.isSafeInteger(reservationMicros) && Number.isSafeInteger(budgetMicros), "Spending limits exceed supported precision");
 const reservation = reservationMicros / 1_000_000;
 const counters = { requests: 0, reservedUsd: 0, rejected: 0, failures: 0, stopReason: null, lastStatus: null };
 const controllers = new Set();
 const server = createServer(async (req, res) => {
  const fail = (status, message, headers = {}) => { if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify({ error: { message, type: "invalid_request_error" } })); };
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") return fail(404, "Only chat completions are allowed");
  const controller = new AbortController(); controllers.add(controller);
  req.setTimeout(15000, () => req.destroy());
  res.on("close", () => controller.abort());
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
   let size = 0; const chunks = [];
   for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new Error("body_limit"); chunks.push(chunk); }
   const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
   const requestedTokens = body.max_tokens ?? body.max_completion_tokens;
   assert.equal(body.model, modelId);
   assert.ok(Number.isInteger(requestedTokens) && requestedTokens > 0 && requestedTokens <= maxTokens);
   for (const key of ["max_tokens", "max_completion_tokens"]) if (body[key] !== undefined) assert.ok(Number.isInteger(body[key]) && body[key] > 0 && body[key] <= maxTokens);
   assert.equal(body.stream, true);
   assert.ok(body.n === undefined || body.n === 1);
   if (counters.stopReason) return fail(400, "Qualification stopped after a provider configuration error");
   if (counters.requests >= maxRequests || (counters.requests + 1) * reservationMicros > budgetMicros) {
    counters.rejected++; return fail(400, "Qualification request or estimated spending budget exhausted");
   }
   const authorization = req.headers.authorization;
   assert.ok(typeof authorization === "string" && authorization.startsWith("Bearer "));
   // Reserve the full context/output ceiling before forwarding, including provider retries.
   // No reservation is refunded, even after an upstream error or missing usage.
   counters.requests++;
   counters.reservedUsd = counters.requests * reservation;
   const response = await fetcher(upstream + "/chat/completions", {
    method: "POST", redirect: "error", signal: controller.signal,
    headers: { "Content-Type": "application/json", "User-Agent": "PamweChete/1.0", Authorization: authorization }, body: JSON.stringify(body)
   });
   counters.lastStatus = response.status;
   if (!response.ok) {
    counters.failures++;
    if ([400, 401, 402, 403, 404, 422].includes(response.status)) counters.stopReason = "provider_configuration_error";
    // Pi 0.87.1's provider retry layer reads only these retry controls.
    const retryHeaders = {};
    for (const name of ["retry-after", "retry-after-ms", "x-should-retry"]) {
     const value = response.headers.get(name);
     if (value !== null && value.length <= 128) retryHeaders[name] = value;
    }
    await response.body?.cancel();
    return fail(response.status, "Provider request failed during qualification", retryHeaders);
   }
   res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
   const reader = response.body.getReader(); let returned = 0;
   try {
    while (true) {
     const { done, value } = await reader.read(); if (done) break;
     returned += value.byteLength;
     if (returned > 16 * 1024 * 1024) throw new Error("response_limit");
     if (!res.write(value)) await new Promise((done, reject) => {
      const cleanup = () => { res.off("drain", drained); res.off("close", closed); };
      const drained = () => { cleanup(); done(); };
      const closed = () => { cleanup(); reject(new Error("closed")); };
      res.once("drain", drained); res.once("close", closed);
     });
    }
   } finally { await reader.cancel(); }
   res.end();
  } catch {
   counters.failures++;
   if (res.headersSent) res.destroy(); else fail(400, "Invalid or interrupted qualification request");
  } finally { clearTimeout(timer); controllers.delete(controller); }
 });
 await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
 return {
  url: "http://127.0.0.1:" + server.address().port + "/v1",
  counters, reservation,
  async close() { for (const controller of controllers) controller.abort(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
 };
}
