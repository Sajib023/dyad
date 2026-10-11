import { withAnthropicPreservedThinking } from "./anthropic_preserved_thinking";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI as createGoogle } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createXai } from "@ai-sdk/xai";
import { createVertex as createGoogleVertex } from "@ai-sdk/google-vertex";
import { createAzure } from "@ai-sdk/azure";
import type { LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { FetchFunction } from "@ai-sdk/provider-utils";
import type {
  LargeLanguageModel,
  ModelSelection,
  UserSettings,
  VertexProviderSetting,
  AzureProviderSetting,
} from "../../lib/schemas";
import { getEnvVar } from "./read_env";
import log from "electron-log";
import { getLanguageModelProviders } from "../shared/language_model_helpers";
import { LanguageModelProvider } from "@/ipc/types";

import { getLmStudioBaseUrl } from "./lm_studio_utils";
import { createOllamaProvider } from "./ollama_provider";
import { getOllamaApiUrl } from "../handlers/local_model_ollama_handler";
import { getTestFetchOption } from "./test_fetch_override";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import {
  findInvalidProviderApiKeyCharacter,
  formatInvalidProviderApiKeyMessage,
  normalizeProviderApiKeyInput,
} from "@/lib/providerApiKey";
import { getOpenRouterAppAttributionHeaders } from "./openrouter_attribution";
import { resolveModelSelection } from "./model_effort";
import { getModelPreferenceKey } from "@/lib/modelEffort";

// The test-only fetch seam lives in ./test_fetch_override (dependency-free,
// so secondary factories can use it without import cycles). Re-exported here
// for existing importers.
export { setModelClientFetchForTesting } from "./test_fetch_override";

function getModelClientFetchOption(): { fetch?: FetchFunction } {
  return getTestFetchOption();
}

export interface ModelClient {
  model: LanguageModel;
  builtinProviderId?: string;
  reasoningEffortProviderId?: string;
  /** Actual source, including the active candidate of an Auto fallback chain. */
  getRuntimeModel?: () => ModelSelection;
}

// Providers whose APIs reject or silently drop inline PDF file parts.
const PDF_UNSUPPORTED_PROVIDERS = new Set(["xai", "ollama", "lmstudio"]);

/**
 * Whether this client can send inline PDF file parts. Unknown providers are
 * assumed to support them; their API errors surface like any other.
 */
export function modelClientSupportsPdfInput(modelClient: ModelClient) {
  return !PDF_UNSUPPORTED_PROVIDERS.has(modelClient.builtinProviderId ?? "");
}

export interface ModelClientResult {
  modelClient: ModelClient;
  runtimeModel: LargeLanguageModel;
  isEngineEnabled?: boolean;
  isSmartContextEnabled?: boolean;
}

const logger = log.scope("getModelClient");

/**
 * Opencode-style, BYOK-only model resolution.
 *
 * There is no Pro gateway, no subscription, no Auto fallback chain and no
 * per-turn connection routing: the caller names an explicit `provider/model`
 * pair and this returns a client built directly against that provider's API
 * with the user's own key (or the local endpoint for ollama/lmstudio).
 *
 * `isEngineEnabled` / `isSmartContextEnabled` are always false and remain
 * only so existing call sites keep compiling; every engine-gated branch
 * downstream is dead.
 */
export async function getModelClient(
  selectedModel: LargeLanguageModel,
  settings: UserSettings,
  modelSelectionOverride?: ModelSelection,
  context?: {
    chatId: number;
    autoModelCandidates?: unknown;
    externalModelAdmission?: unknown;
  },
): Promise<ModelClientResult> {
  void context;
  const selectedModelSelection =
    modelSelectionOverride ??
    (await resolveModelSelection({
      model: selectedModel,
      preferredEffortLevel:
        settings.modelEffortPreferences?.[getModelPreferenceKey(selectedModel)],
    }));

  // Retired selectors from the Pro era cannot resolve to an API.
  if (
    selectedModelSelection.provider === "auto" ||
    selectedModelSelection.provider === "claude-code"
  ) {
    throw new DyadError(
      "Pick a specific provider and model in the model picker (e.g. anthropic / Claude Sonnet 4.6). Automatic selection is no longer supported.",
      DyadErrorKind.Validation,
    );
  }

  const {
    effortLevel: _effort,
    connection: _connection,
    ...runtimeModel
  } = selectedModelSelection;

  const allProviders = await getLanguageModelProviders();
  const providerConfig = allProviders.find(
    (p) => p.id === runtimeModel.provider,
  );

  if (!providerConfig) {
    throw new DyadError(
      `Configuration not found for provider: ${runtimeModel.provider}`,
      DyadErrorKind.NotFound,
    );
  }

  const regular = getRegularModelClient(runtimeModel, settings, providerConfig);
  return {
    ...regular,
    runtimeModel,
    isEngineEnabled: false,
    isSmartContextEnabled: false,
  };
}

function getRegularModelClient(
  model: LargeLanguageModel,
  settings: UserSettings,
  providerConfig: LanguageModelProvider,
): {
  modelClient: ModelClient;
  backupModelClients: ModelClient[];
} {
  const providerId = providerConfig.id;
  // Get API key for the specific provider. Azure is handled in its own branch
  // because it has additional config and test-mode bypass behavior.
  const apiKey =
    providerId === "azure"
      ? undefined
      : getProviderApiKeyForRequest(
          settings.providerSettings?.[model.provider]?.apiKey?.value ||
            (providerConfig.envVarName
              ? getEnvVar(providerConfig.envVarName)
              : undefined),
          providerConfig.name ?? providerConfig.id,
        );
  // Create client based on provider ID or type
  switch (providerId) {
    case "openai": {
      const provider = createOpenAI({
        apiKey,
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider.responses(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "anthropic": {
      const provider = createAnthropic({
        apiKey,
        fetch: withAnthropicPreservedThinking(
          getModelClientFetchOption().fetch,
        ),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "xai": {
      const provider = createXai({
        apiKey,
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "google": {
      const provider = createGoogle({
        apiKey,
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "vertex": {
      // Vertex uses Google service account credentials with project/location
      const vertexSettings = settings.providerSettings?.[
        model.provider
      ] as VertexProviderSetting;
      const project = vertexSettings?.projectId;
      const location = vertexSettings?.location;
      const serviceAccountKey = vertexSettings?.serviceAccountKey?.value;

      // Use a baseURL that does NOT pin to publishers/google so that
      // full publisher model IDs (e.g. publishers/deepseek-ai/models/...) work.
      const regionHost = `${location === "global" ? "" : `${location}-`}aiplatform.googleapis.com`;
      const baseURL = `https://${regionHost}/v1/projects/${project}/locations/${location}`;
      const provider = createGoogleVertex({
        project,
        location,
        baseURL,
        ...getModelClientFetchOption(),
        googleAuthOptions: serviceAccountKey
          ? {
              // Expecting the user to paste the full JSON of the service account key
              credentials: JSON.parse(serviceAccountKey),
            }
          : undefined,
      });
      return {
        modelClient: {
          // For built-in Google models on Vertex, the path must include
          // publishers/google/models/<model>. For partner MaaS models the
          // full publisher path is already included.
          model: provider(
            model.name.includes("/")
              ? model.name
              : `publishers/google/models/${model.name}`,
          ),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "openrouter": {
      const provider = createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey,
        headers: getOpenRouterAppAttributionHeaders(),
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "azure": {
      // Check if we're in e2e testing mode
      const testAzureBaseUrl = getEnvVar("TEST_AZURE_BASE_URL");

      if (testAzureBaseUrl) {
        // Use fake server for e2e testing
        logger.info(`Using test Azure base URL: ${testAzureBaseUrl}`);
        const provider = createOpenAICompatible({
          name: "azure-test",
          baseURL: testAzureBaseUrl,
          apiKey: "fake-api-key-for-testing",
          ...getModelClientFetchOption(),
        });
        return {
          modelClient: {
            model: provider(model.name),
            builtinProviderId: providerId,
          },
          backupModelClients: [],
        };
      }

      const azureSettings = settings.providerSettings?.azure as
        | AzureProviderSetting
        | undefined;
      const azureApiKeyFromSettings = normalizeProviderApiKeyInput(
        azureSettings?.apiKey?.value,
      );
      const azureResourceNameFromSettings = (
        azureSettings?.resourceName ?? ""
      ).trim();
      const envResourceName = (getEnvVar("AZURE_RESOURCE_NAME") ?? "").trim();
      const envAzureApiKey = normalizeProviderApiKeyInput(
        getEnvVar("AZURE_API_KEY"),
      );

      const resourceName = azureResourceNameFromSettings || envResourceName;
      const azureApiKey = getProviderApiKeyForRequest(
        azureApiKeyFromSettings || envAzureApiKey,
        providerConfig.name ?? providerConfig.id,
      );

      if (!resourceName) {
        throw new Error(
          "Azure OpenAI resource name is required. Provide it in Settings or set the AZURE_RESOURCE_NAME environment variable.",
        );
      }

      if (!azureApiKey) {
        throw new Error(
          "Azure OpenAI API key is required. Provide it in Settings or set the AZURE_API_KEY environment variable.",
        );
      }

      const provider = createAzure({
        resourceName,
        apiKey: azureApiKey,
        ...getModelClientFetchOption(),
      });

      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
          reasoningEffortProviderId: "azure",
        },
        backupModelClients: [],
      };
    }
    case "ollama": {
      const provider = createOllamaProvider({
        baseURL: getOllamaApiUrl(),
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
          reasoningEffortProviderId: "ollama",
        },
        backupModelClients: [],
      };
    }
    case "lmstudio": {
      // LM Studio uses OpenAI compatible API
      const baseURL = providerConfig.apiBaseUrl || getLmStudioBaseUrl() + "/v1";
      const provider = createOpenAICompatible({
        name: "lmstudio",
        baseURL,
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
          reasoningEffortProviderId: "lmstudio",
        },
        backupModelClients: [],
      };
    }
    case "bedrock": {
      // AWS Bedrock supports API key authentication using AWS_BEARER_TOKEN_BEDROCK
      // See: https://sdk.vercel.ai/providers/ai-sdk-providers/amazon-bedrock#api-key-authentication
      const provider = createAmazonBedrock({
        apiKey: apiKey,
        region: getEnvVar("AWS_REGION") || "us-east-1",
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    case "minimax": {
      const provider = createOpenAICompatible({
        name: "minimax",
        baseURL: "https://api.minimax.io/v1",
        apiKey,
        ...getModelClientFetchOption(),
      });
      return {
        modelClient: {
          model: provider(model.name),
          builtinProviderId: providerId,
        },
        backupModelClients: [],
      };
    }
    default: {
      // Handle custom providers (OpenAI-compatible or Anthropic-compatible,
      // per the provider's configured protocol).
      if (providerConfig.type === "custom") {
        if (!providerConfig.apiBaseUrl) {
          throw new Error(
            `Custom provider ${model.provider} is missing the API Base URL.`,
          );
        }
        if ((providerConfig.apiProtocol ?? "openai") === "anthropic") {
          const provider = createAnthropic({
            apiKey,
            baseURL: providerConfig.apiBaseUrl,
            fetch: withAnthropicPreservedThinking(
              getModelClientFetchOption().fetch,
            ),
          });
          return {
            modelClient: {
              model: provider(model.name),
              builtinProviderId: providerConfig.id,
              reasoningEffortProviderId: providerConfig.id,
            },
            backupModelClients: [],
          };
        }
        const provider = createOpenAICompatible({
          name: providerConfig.id,
          baseURL: providerConfig.apiBaseUrl,
          apiKey,
          ...getModelClientFetchOption(),
        });
        return {
          modelClient: {
            model: provider(model.name),
            builtinProviderId: providerConfig.id,
            reasoningEffortProviderId: providerConfig.id,
          },
          backupModelClients: [],
        };
      }
      // If it's not a known ID and not type 'custom', it's unsupported
      throw new DyadError(
        `Unsupported model provider: ${model.provider}`,
        DyadErrorKind.Validation,
      );
    }
  }
}

export function getProviderApiKeyForRequest(
  value: string | null | undefined,
  providerDisplayName: string,
): string | undefined {
  const normalizedValue = normalizeProviderApiKeyInput(value);
  if (!normalizedValue) {
    return undefined;
  }
  const invalidCharacter = findInvalidProviderApiKeyCharacter(normalizedValue);
  if (invalidCharacter) {
    throw new DyadError(
      formatInvalidProviderApiKeyMessage(providerDisplayName, invalidCharacter),
      DyadErrorKind.Validation,
    );
  }
  return normalizedValue;
}
