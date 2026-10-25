import type { Provider, StreamOptions } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { FastModel } from "./fast-mode.ts";

/** Decorate native dispatch, after host auth resolution but before any payload hook. */
export function createFastProvider(prepare: (
	model: FastModel, apiKey: string | undefined, signal: AbortSignal | undefined,
) => (payload: unknown) => Promise<unknown | undefined>): Provider<"openai-codex-responses"> {
	// Pi's extension loader explicitly maps providers/all; individual provider
	// subpaths are not portable through its pi-ai compatibility alias.
	const builtinProvider = builtinProviders().find((provider) => provider.id === "openai-codex") as Provider<"openai-codex-responses"> | undefined;
	if (!builtinProvider) throw new Error("The pi host does not provide openai-codex");
	function wrapOptions<T extends StreamOptions>(model: FastModel, options: T | undefined): T & StreamOptions {
		const transform = prepare(model, options?.apiKey, options?.signal);
		const onPayload = options?.onPayload;
		return {
			...options,
			onPayload: async (payload, nativeModel) => {
				const replacement = await onPayload?.(payload, nativeModel);
				const current = replacement === undefined ? payload : replacement;
				const final = await transform(current);
				return final === undefined ? current : final;
			},
		} as T & StreamOptions;
	}
	return {
		...builtinProvider,
		stream(model, context, options) {
			return builtinProvider.stream(model, context, wrapOptions(model, options));
		},
		streamSimple(model, context, options) {
			return builtinProvider.streamSimple(model, context, wrapOptions(model, options));
		},
	};
}
