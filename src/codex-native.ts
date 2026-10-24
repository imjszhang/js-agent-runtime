/**
 * Native ChatGPT login is an OAuth transport, not an OpenAI API-key endpoint.
 * The installed CLI accepts requires_openai_auth on custom Responses providers;
 * the same configuration is used by its account/model metadata connection.
 * Keep this shared so a successful probe cannot hide a different execution route.
 */
export function nativeCodexProviderConfig(provider: string): Record<string, unknown> {
  return {
    model_provider: provider,
    [`model_providers.${provider}.name`]: "OpenAI",
    [`model_providers.${provider}.base_url`]: "https://chatgpt.com/backend-api/codex",
    [`model_providers.${provider}.model_catalog_url`]: "https://chatgpt.com/backend-api/codex/models",
    [`model_providers.${provider}.wire_api`]: "responses",
    [`model_providers.${provider}.requires_openai_auth`]: true,
    chatgpt_base_url: "https://chatgpt.com/backend-api/",
  };
}
