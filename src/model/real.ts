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

export interface AnthropicCompatibleOptions {
  baseUrl: string;
  modelId: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

/**
 * An Anthropic Messages-compatible endpoint that is not in pi-ai's catalog,
 * for example DeepSeek's `/anthropic` compatibility endpoint or an internal
 * gateway.
 *
 * The request shape is the Anthropic Messages API. Auth still comes from
 * `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` through pi-ai.
 */
export function createAnthropicCompatibleRuntime(
  options: AnthropicCompatibleOptions,
): RealRuntime {
  const models = createModels();
  models.setProvider(anthropicProvider());
  const model = {
    id: options.modelId,
    name: options.name ?? options.modelId,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: options.baseUrl.replace(/\/+$/, ""),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: options.reasoning ?? false,
    contextWindow: options.contextWindow ?? 1_000_000,
    maxTokens: options.maxTokens ?? 8192,
  } as Model<Api>;
  return {
    models,
    model,
    streamFn: models.streamSimple.bind(models) as StreamFn,
    available: [options.modelId],
  };
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
