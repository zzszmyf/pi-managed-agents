import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, type Api, type Model, type Models } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export type RealProvider = "anthropic" | "openai";

export interface RealRuntime {
  models: Models;
  model: Model<Api>;
  streamFn: StreamFn;
  available: string[];
}

/**
 * A real provider runtime. Auth is resolved by pi-ai from the usual
 * environment variables (ANTHROPIC_API_KEY, OPENAI_API_KEY, OAuth stores,
 * etc.).
 */
export function createRealRuntime(provider: RealProvider, modelId?: string): RealRuntime {
  const models = createModels();
  models.setProvider(provider === "anthropic" ? anthropicProvider() : openaiProvider());
  const available = models.getModels(provider);
  const model = modelId ? models.getModel(provider, modelId) : available[0];
  if (!model) {
    const ids = available.map((entry) => entry.id).join(", ");
    throw new Error(
      modelId
        ? `Unknown ${provider} model "${modelId}". Available: ${ids}`
        : `No ${provider} models available. Pass --model. Available: ${ids}`,
    );
  }
  return {
    models,
    model,
    streamFn: models.streamSimple.bind(models) as StreamFn,
    available: available.map((entry) => entry.id),
  };
}
