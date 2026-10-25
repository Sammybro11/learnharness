/**
 * The Hyper provider (app-registered, 2026-10): Hyper is an OpenAI-compatible
 * gateway (https://hyper.charm.land/v1) that pi-ai has no catalog for, so it
 * is built here and registered into the app's one Models collection
 * (src/agent/models.ts). Everything model-shaped comes from Hyper's own
 * /models payload — no invented constants, so a new upstream model or a price
 * change needs no code here.
 *
 * KEY HANDLING: the key rides HYPER_API_KEY exactly like every builtin
 * provider's (core/auth-keys.ts APP_PROVIDER_KEYS → the Keys page → the env
 * seam → pi-ai's own env resolution at request time).
 */
import { createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const HYPER_PROVIDER_ID = "hyper";
export const HYPER_BASE_URL = "https://hyper.charm.land/v1";

/** One entry of Hyper's public GET /models payload. Only `id` is guaranteed;
 *  everything else is best-effort, so every read below is optional-chained. */
interface HyperModelEntry {
	id: string;
	display_name?: string;
	reasoning?: boolean;
	/** Hyper calls it context_window (NOT context_length). */
	context_window?: number;
	max_output_tokens?: number;
	capabilities?: { vision?: boolean };
	/** USD per 1M tokens — the same unit pi-ai's Model.cost fields use. */
	pricing?: { input?: number; output?: number; cache_create?: number; cache_hit?: number };
}

/** Excluded from the catalog entirely by owner decision. */
const EXCLUDED_MODEL_IDS = new Set(["prism"]);

/** Map one payload entry to pi-ai's chat-model shape. */
function toModel(entry: HyperModelEntry): Model<"openai-completions"> {
	return {
		id: entry.id,
		name: entry.display_name ?? entry.id,
		api: "openai-completions",
		provider: HYPER_PROVIDER_ID,
		baseUrl: HYPER_BASE_URL,
		reasoning: entry.reasoning ?? false,
		input: entry.capabilities?.vision ? ["text", "image"] : ["text"],
		cost: {
			input: entry.pricing?.input ?? 0,
			output: entry.pricing?.output ?? 0,
			cacheRead: entry.pricing?.cache_hit ?? 0,
			cacheWrite: entry.pricing?.cache_create ?? 0,
		},
		contextWindow: entry.context_window ?? 0,
		maxTokens: entry.max_output_tokens ?? 0,
	};
}

/** The provider's one dynamic model source. The endpoint is PUBLIC
 *  (probe-verified: 200 with or without an Authorization header), so no
 *  credential is sent — the key only gates whether the provider federates. */
export function hyperProvider() {
	return createProvider<"openai-completions">({
		id: HYPER_PROVIDER_ID,
		name: "Hyper",
		baseUrl: HYPER_BASE_URL,
		auth: { apiKey: envApiKeyAuth("Hyper API key", ["HYPER_API_KEY"]) },
		models: [],
		api: openAICompletionsApi(),
		fetchModels: async (context) => {
			// Offline/cache-only start: no models, no throw — an empty catalog
			// must never break a boot.
			if (context.allowNetwork === false) return [];
			const base = (context.baseUrl ?? HYPER_BASE_URL).replace(/\/+$/, "");
			const res = await fetch(`${base}/models`, {
				signal: AbortSignal.any([context.signal, AbortSignal.timeout(20_000)]),
			});
			if (!res.ok) throw new Error(`hyper model list failed: ${res.status}`);
			const body = (await res.json()) as { data?: HyperModelEntry[] };
			return (body.data ?? [])
				.filter((entry) => !EXCLUDED_MODEL_IDS.has(entry.id))
				.map(toModel);
		},
	});
}
