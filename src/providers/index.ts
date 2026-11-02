// Provider factory: builds the concrete provider chosen by the resolved
// settings (config file + environment). Both providers expose the same
// `name` / `model` / `baseURL` surface the CLI banner uses.

import type { ResolvedSettings } from "../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

export type AnyProvider = OpenAICompatibleProvider | AnthropicProvider;

export function createProvider(settings: ResolvedSettings): AnyProvider {
  if (settings.provider === "anthropic") {
    return new AnthropicProvider({
      baseURL: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
    });
  }
  return new OpenAICompatibleProvider({
    baseURL: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
  });
}
