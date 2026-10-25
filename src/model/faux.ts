import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxProvider,
  type Api,
  type FauxProviderHandle,
  type FauxResponseStep,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";

export interface FauxRuntime {
  faux: FauxProviderHandle;
  models: Models;
  model: Model<Api>;
  streamFn: StreamFn;
}

/**
 * Deterministic model runtime for demos and tests.
 *
 * The faux provider scripts assistant responses, including tool calls, without
 * any API key or network access. It also simulates prompt caching.
 */
export function createFauxRuntime(
  responses: FauxResponseStep[] = [],
  options: { tokensPerSecond?: number; provider?: string } = {},
): FauxRuntime {
  const faux = fauxProvider({
    ...(options.tokensPerSecond !== undefined ? { tokensPerSecond: options.tokensPerSecond } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return {
    faux,
    models,
    model: faux.getModel() as unknown as Model<Api>,
    streamFn: models.streamSimple.bind(models) as StreamFn,
  };
}

/**
 * Wrap a stream function so tests can inspect exactly what context the harness
 * sent to the provider before each request.
 */
export function recordContexts(
  streamFn: StreamFn,
): { streamFn: StreamFn; contexts: Array<Array<{ role: string }>> } {
  const contexts: Array<Array<{ role: string }>> = [];
  const wrapped: StreamFn = (model, context, options) => {
    contexts.push(context.messages.map((message) => ({ role: message.role })));
    return streamFn(model, context, options);
  };
  return { streamFn: wrapped, contexts };
}
