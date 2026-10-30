import type { Provider, StreamOptions } from "@earendil-works/pi-ai";
import type { FastModel } from "./fast-mode.ts";

/** Decorate native dispatch, after host auth resolution but before any payload hook. */
export function createFastProvider(builtinProvider: Provider, prepare: (
	model: FastModel, apiKey: string | undefined, signal: AbortSignal | undefined,
) => (payload: unknown) => Promise<unknown | undefined>): Provider {
	const bound = new Map<PropertyKey, { original: Function; method: Function }>();
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
	const decorated: Provider = {
		...builtinProvider,
		stream(model, context, options) {
			return builtinProvider.stream(model, context, wrapOptions(model, options));
		},
		streamSimple(model, context, options) {
			return builtinProvider.streamSimple(model, context, wrapOptions(model, options));
		},
	};
	// Delegate reads too: live catalogs, getters and prototype methods must keep
	// the native receiver, rather than a snapshot or this decorator as `this`.
	return new Proxy(decorated, {
		get(target, key, receiver) {
			if (key === "stream" || key === "streamSimple") return Reflect.get(target, key, receiver);
			const value = Reflect.get(builtinProvider, key, builtinProvider);
			if (typeof value !== "function") return value;
			let entry = bound.get(key);
			if (!entry || entry.original !== value) {
				entry = { original: value, method: value.bind(builtinProvider) };
				bound.set(key, entry);
			}
			return entry.method;
		},
	});
}
