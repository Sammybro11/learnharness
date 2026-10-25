/**
 * The Hyper provider (app-registered, 2026-10): pins the mapping from
 * Hyper's own /models payload to pi-ai's chat-model shape (costs, context
 * windows, vision modality, the owner-excluded `prism`), the HYPER_API_KEY
 * auth plumbing, and the offline (allowNetwork:false) contract.
 *
 * Everything here runs against a PRIVATE createModels() collection with an
 * injected env — no production singleton, no real process.env, and fetch is
 * a closed stub (restored in a finally block).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModels, type MutableModels } from "@earendil-works/pi-ai";
import { HYPER_BASE_URL, HYPER_PROVIDER_ID, hyperProvider } from "../src/agent/hyper-provider.ts";

/** Hyper's payload shape, canned: one vision reasoning model, one text-only
 *  model, and the owner-excluded `prism`. */
const PAYLOAD = {
	object: "list",
	data: [
		{
			id: "lumen", object: "model", created: 0, owned_by: "hyper", display_name: "Lumen",
			producer: "Charm", context_window: 200_000, max_output_tokens: 8_000, reasoning: true,
			capabilities: { vision: true },
			pricing: { input: 1.5, output: 6, cache_create: 2, cache_hit: 0.15 },
		},
		{
			id: "swift", object: "model", created: 0, owned_by: "hyper", display_name: "Swift",
			context_window: 32_000, max_output_tokens: 2_000,
			capabilities: { vision: false },
			pricing: { input: 0.5, output: 1.5, cache_create: 0, cache_hit: 0.05 },
		},
		{ id: "prism", display_name: "Prism", context_window: 1_000_000, max_output_tokens: 16_000 },
	],
};

/** Replace global fetch with a canned 200 for the duration of `run`. */
async function withFetch<T>(run: (calls: () => number) => Promise<T>): Promise<T> {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls += 1;
		return { ok: true, status: 200, json: async () => structuredClone(PAYLOAD) } as unknown as Response;
	}) as typeof fetch;
	try {
		return await run(() => calls);
	} finally {
		globalThis.fetch = original;
	}
}

/** A private collection whose auth reads only the given env. */
function privateModels(env: Record<string, string | undefined>): MutableModels {
	const models = createModels({ authContext: { env: async (name) => env[name], fileExists: async () => false } });
	models.setProvider(hyperProvider());
	return models;
}

describe("hyper provider", () => {
	it("maps Hyper's /models payload (costs, windows, vision, reasoning) and drops prism", async () => {
		await withFetch(async () => {
			const models = privateModels({ HYPER_API_KEY: "dummy-hyper-key" });
			const result = await models.refresh({ providers: [HYPER_PROVIDER_ID], allowNetwork: true });
			assert.deepEqual([...result.errors], [], "refresh reports no errors");

			const listed = models.getModels(HYPER_PROVIDER_ID);
			assert.deepEqual(listed.map((m) => m.id), ["lumen", "swift"], "prism is excluded by owner decision");
			assert.deepEqual(listed.map((m) => m.name), ["Lumen", "Swift"]);

			const lumen = listed.find((m) => m.id === "lumen")!;
			const swift = listed.find((m) => m.id === "swift")!;
			assert.equal(lumen.reasoning, true);
			assert.deepEqual(lumen.input, ["text", "image"], "vision capability ⇒ image input");
			assert.deepEqual(swift.input, ["text"], "no vision capability ⇒ text only");
			assert.deepEqual(lumen.cost, { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 2 },
				"pricing.input/output/cache_hit/cache_create map straight across (USD per 1M)");
			assert.equal(lumen.contextWindow, 200_000);
			assert.equal(lumen.maxTokens, 8_000);
			assert.equal(swift.contextWindow, 32_000);
			assert.equal(swift.maxTokens, 2_000);
			assert.equal(lumen.baseUrl, HYPER_BASE_URL);
			assert.equal(lumen.api, "openai-completions");
		});
	});

	it("resolves HYPER_API_KEY as hyper's credential and gates availability on it", async () => {
		await withFetch(async () => {
			const env: Record<string, string | undefined> = { HYPER_API_KEY: "dummy-hyper-key" };
			const models = privateModels(env);
			await models.refresh({ providers: [HYPER_PROVIDER_ID], allowNetwork: true });

			const resolved = await models.getAuth(HYPER_PROVIDER_ID);
			assert.equal(resolved?.source, "HYPER_API_KEY");
			assert.equal(resolved?.auth.apiKey, "dummy-hyper-key");

			env.HYPER_API_KEY = undefined;
			assert.equal(await models.getAuth(HYPER_PROVIDER_ID), undefined, "unset key ⇒ unconfigured");
			const available = await models.getAvailable();
			assert.equal(available.some((m) => m.provider === HYPER_PROVIDER_ID), false, "keyless provider federates nothing");
			assert.ok(models.getModels(HYPER_PROVIDER_ID).length > 0, "the fetched catalog itself survives — auth is the gate");
		});
	});

	it("allowNetwork:false lists no models and never fetches", async () => {
		await withFetch(async (calls) => {
			const provider = hyperProvider();
			await provider.refreshModels!({ allowNetwork: false, signal: new AbortController().signal, publish: async () => true });
			assert.equal(calls(), 0, "offline start must not touch the network");
			assert.deepEqual(provider.getModels(), []);
		});
	});
});
