import { modelForChatBackend } from "@/shared/execution_backend";
import {
  executionBackendForModel,
  requiresNewChatForModel,
} from "@/shared/execution_backend";
import { useSelectChat } from "@/hooks/useSelectChat";
import { type LargeLanguageModel } from "@/lib/schemas";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { usePostHog } from "posthog-js/react";
import { useLocalModels } from "@/hooks/useLocalModels";
import { useLocalLMSModels } from "@/hooks/useLMStudioModels";
import { useLanguageModelsByProviders } from "@/hooks/useLanguageModelsByProviders";

import { ipc, type LanguageModel, type LocalModel } from "@/ipc/types";
import { useLanguageModelProviders } from "@/hooks/useLanguageModelProviders";
import { useSettings } from "@/hooks/useSettings";
import { PriceBadge } from "@/components/PriceBadge";
import { cn } from "@/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CheckIcon, ChevronRightIcon, LockIcon } from "lucide-react";
import { ProviderIcon } from "@/components/ProviderIcon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { providerSettingsRoute } from "@/routes/settings/providers/$provider";
import { useRouterState } from "@tanstack/react-router";
import { useChatMode } from "@/hooks/useChatMode";
import {
  createModelSelection,
  formatCompactEffortLevel,
  formatEffortLevel,
  getEffortSettings,
  getModelPreferenceKey,
} from "@/lib/modelEffort";
import {
  addRecentModel,
  getEffectiveRecentModels,
  isSameModel,
} from "@/lib/recentModels";

const SCROLL_AREA_CLASS = "max-h-100 overflow-y-auto scrollbar-on-hover";

const MODEL_MENU_WIDTH_CLASS = "w-[min(20rem,calc(100vw-1.5rem))]";

const PILL_CLASS =
  "text-[10px] leading-none px-1.5 py-1 rounded-full font-medium";

const NAVIGATION_SUBMENU_HOVER_PROPS = {
  openOnHover: true,
  delay: 120,
  closeDelay: 100,
} as const;

type Tier = { label: string; caption: string; min: number; max: number };
type RecentModelEntry =
  | { type: "cloud"; providerId: string; model: LanguageModel }
  | {
      type: "local";
      providerId: "ollama" | "lmstudio";
      model: LocalModel;
    }
  | {
      type: "local-loading";
      providerId: "ollama" | "lmstudio";
      modelName: string;
    };
type ModelSelectParams = {
  model: LargeLanguageModel;
  catalogModel?: LanguageModel | null;
  effortLevel?: string;
  rememberEffort?: boolean;
};
const PRICE_TIERS: Tier[] = [
  {
    label: "Premium",
    caption: "Strongest and most expensive",
    min: 6,
    max: Number.POSITIVE_INFINITY,
  },
  {
    label: "Standard",
    caption: "Balanced quality and cost",
    min: 3,
    max: 5,
  },
  {
    label: "Value",
    caption: "Most cost-efficient",
    min: Number.NEGATIVE_INFINITY,
    max: 2,
  },
];

const isFreeOpenRouterModelName = (apiName: string) =>
  apiName.endsWith(":free") || apiName.endsWith("/free");

const formatModelCount = (count: number) =>
  `${count} model${count === 1 ? "" : "s"}`;

const isEffortChevronTarget = (target: EventTarget) =>
  (target as HTMLElement).closest("[data-effort-chevron]") !== null;

const toRecentModelIdentity = (
  model: LargeLanguageModel,
): LargeLanguageModel => ({
  provider: model.provider,
  name: model.name,
  ...(model.customModelId !== undefined
    ? { customModelId: model.customModelId }
    : {}),
});

function tierFor(dollarSigns: number | undefined): Tier {
  const ds = dollarSigns ?? Number.NEGATIVE_INFINITY;
  return (
    PRICE_TIERS.find((t) => ds >= t.min && ds <= t.max) ??
    PRICE_TIERS[PRICE_TIERS.length - 1]
  );
}

export function ModelPicker() {
  const { settings, updateSettings, loading: settingsLoading } = useSettings();
  const routerState = useRouterState();
  const isChatRoute = routerState.location.pathname === "/chat";
  const chatId = routerState.location.search.id as number | undefined;
  const {
    chat,
    isLoading: chatLoading,
    selectedMode,
    setChatSelection,
  } = useChatMode(isChatRoute ? chatId : null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const posthog = usePostHog();

  const hasEstablishedChat = Boolean(
    chat && (chat.modelSelection || chat.messages.length > 0),
  );
  const { selectChat } = useSelectChat();
  const [pendingBackend, setPendingBackend] = useState<
    (ModelSelectParams & { recentModels: LargeLanguageModel[] }) | null
  >(null);
  const [open, setOpen] = useState(false);
  const requiresNewChat = (model: LargeLanguageModel) =>
    Boolean(isChatRoute && chat && requiresNewChatForModel(chat, model));
  const performModelSelect = async ({
    model,
    catalogModel,
    effortLevel,
    rememberEffort = false,
    recentModels,
    confirmed = false,
  }: ModelSelectParams & {
    recentModels: LargeLanguageModel[];
    confirmed?: boolean;
  }) => {
    if (!settings || (isChatRoute && chatId != null && chatLoading)) return;
    const backendChange = requiresNewChat(model);
    if (!confirmed && backendChange) {
      confirmBackend.reset();
      setPendingBackend({
        model,
        catalogModel,
        effortLevel,
        rememberEffort,
        recentModels,
      });
      setOpen(false);
      return;
    }
    const modelSelection = createModelSelection({
      model,
      catalogModel,
      preferredEffortLevel:
        effortLevel ??
        settings.modelEffortPreferences?.[getModelPreferenceKey(model)],
    });
    posthog.capture("model-picker:select", {
      provider: model.provider,
      model: model.name,
      effortLevel: modelSelection.effortLevel,
    });
    const preferenceUpdate = rememberEffort
      ? {
          modelEffortPreferences: {
            ...settings.modelEffortPreferences,
            [getModelPreferenceKey(model)]: modelSelection.effortLevel,
          },
        }
      : {};
    const recentModelsUpdate = {
      recentModels: addRecentModel(recentModels, model),
    };
    if (backendChange && chat) {
      const newId = await ipc.chat.createChat({
        appId: chat.appId,
        initialChatMode: selectedMode,
        modelSelection,
      });
      await updateSettings({
        selectedModel: model,
        ...preferenceUpdate,
        ...recentModelsUpdate,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
      selectChat({ chatId: newId, appId: chat.appId });
    } else if (
      isChatRoute &&
      chat &&
      chatId &&
      (hasEstablishedChat ||
        executionBackendForModel(model) !== (chat.executionBackend ?? "dyad"))
    ) {
      await setChatSelection({
        modelSelection,
      });
      if (rememberEffort || "recentModels" in recentModelsUpdate) {
        await updateSettings({
          ...preferenceUpdate,
          ...recentModelsUpdate,
        });
      }
    } else {
      await updateSettings({
        selectedModel: model,
        ...preferenceUpdate,
        ...recentModelsUpdate,
      });
    }
    // Invalidate token count when model changes since different models have different context windows
    // (technically they have different tokenizers, but we don't keep track of that).
    queryClient.invalidateQueries({ queryKey: queryKeys.tokenCount.all });
  };

  const confirmBackend = useMutation({
    mutationFn: async () => {
      if (!pendingBackend) return;
      await performModelSelect({
        ...pendingBackend,
        confirmed: true,
      });
      setPendingBackend(null);
    },
  });
  const [unlockTarget, setUnlockTarget] = useState<{
    providerId: string;
    model: LanguageModel;
  } | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      posthog.capture("model-picker:open", {});
    }
  };

  // Cloud models from providers
  const {
    data: modelsByProviders,
    isLoading: modelsByProvidersLoading,
    error: modelsByProvidersError,
  } = useLanguageModelsByProviders();

  const {
    data: providers,
    isLoading: providersLoading,
    error: providersError,
    isProviderSetup,
  } = useLanguageModelProviders();

  const loading = modelsByProvidersLoading || providersLoading;
  // Ollama Models Hook
  const {
    models: ollamaModels,
    loading: ollamaLoading,
    error: ollamaError,
    loadModels: loadOllamaModels,
  } = useLocalModels();

  // LM Studio Models Hook
  const {
    models: lmStudioModels,
    loading: lmStudioLoading,
    error: lmStudioError,
    loadModels: loadLMStudioModels,
  } = useLocalLMSModels();
  const [localProvidersLoaded, setLocalProvidersLoaded] = useState({
    ollama: false,
    lmstudio: false,
  });

  // Load models when the dropdown opens
  useEffect(() => {
    if (open) {
      let active = true;
      setLocalProvidersLoaded({ ollama: false, lmstudio: false });
      void loadOllamaModels().finally(() => {
        if (active) {
          setLocalProvidersLoaded((loaded) => ({ ...loaded, ollama: true }));
        }
      });
      void loadLMStudioModels().finally(() => {
        if (active) {
          setLocalProvidersLoaded((loaded) => ({
            ...loaded,
            lmstudio: true,
          }));
        }
      });
      return () => {
        active = false;
      };
    }
  }, [open, loadOllamaModels, loadLMStudioModels]);

  // Get display name for the selected model
  const selectedModel: LargeLanguageModel = modelForChatBackend(chat, settings);

  const getModelDisplayName = (
    displayModel: LargeLanguageModel = selectedModel,
  ) => {
    if (displayModel.provider === "ollama") {
      return (
        ollamaModels.find(
          (model: LocalModel) => model.modelName === displayModel.name,
        )?.displayName || displayModel.name
      );
    }
    if (displayModel.provider === "lmstudio") {
      return (
        lmStudioModels.find(
          (model: LocalModel) => model.modelName === displayModel.name,
        )?.displayName || displayModel.name // Fallback to path if not found
      );
    }

    // For cloud models, look up in the modelsByProviders data
    if (modelsByProviders && modelsByProviders[displayModel.provider]) {
      const customFoundModel = modelsByProviders[displayModel.provider].find(
        (model) =>
          model.type === "custom" && model.id === displayModel.customModelId,
      );
      if (customFoundModel) {
        return customFoundModel.displayName;
      }
      const foundModel = modelsByProviders[displayModel.provider].find(
        (model) => model.apiName === displayModel.name,
      );
      if (foundModel) {
        return foundModel.displayName;
      }
    }

    // Fallback if not found
    return displayModel.name;
  };

  if (!settings) {
    return null;
  }
  const selectedCatalogModel = modelsByProviders?.[
    selectedModel.provider
  ]?.find((model) =>
    selectedModel.customModelId !== undefined
      ? model.type === "custom" && model.id === selectedModel.customModelId
      : model.apiName === selectedModel.name,
  );
  const normalizedSelectedModel =
    selectedModel.customModelId === undefined &&
    selectedCatalogModel?.type === "custom" &&
    selectedCatalogModel.id !== undefined
      ? { ...selectedModel, customModelId: selectedCatalogModel.id }
      : selectedModel;
  const selectedEffortLevel = createModelSelection({
    model: selectedModel,
    catalogModel: selectedCatalogModel,
    preferredEffortLevel:
      chat?.modelSelection?.effortLevel ??
      settings.modelEffortPreferences?.[getModelPreferenceKey(selectedModel)],
  }).effortLevel;
  const modelDisplayName = getModelDisplayName();
  // The root menu is a quick switcher. The complete catalog is prepared here
  // for the nested "All models" menu.
  const providerEntries =
    !loading && modelsByProviders
      ? Object.entries(modelsByProviders).filter(
          ([providerId]) => providerId !== "auto",
        )
      : [];
  // All catalog models are visible; locked (keyless) ones open provider
  // settings instead of selecting.
  const isVisibleCatalogModel = (_providerId: string, _model: LanguageModel) =>
    true;
  const isOtherProvider = (providerId: string) => {
    const provider = providers?.find(
      (candidate) => candidate.id === providerId,
    );
    return provider?.secondary === true || provider?.type === "custom";
  };
  const primaryModelEntries = providerEntries
    .filter(([providerId]) => !isOtherProvider(providerId))
    .flatMap(([providerId, models], providerIndex) =>
      models.flatMap((model, modelIndex) => {
        if (!isVisibleCatalogModel(providerId, model)) {
          return [];
        }
        return [{ providerId, model, providerIndex, modelIndex }];
      }),
    )
    .sort((a, b) => {
      const aPrice = a.model.dollarSigns ?? Number.NEGATIVE_INFINITY;
      const bPrice = b.model.dollarSigns ?? Number.NEGATIVE_INFINITY;
      if (aPrice !== bPrice) {
        return bPrice - aPrice;
      }
      if (a.providerIndex !== b.providerIndex) {
        return a.providerIndex - b.providerIndex;
      }
      return a.modelIndex - b.modelIndex;
    });
  const otherProviderEntries = providerEntries
    .filter(([providerId]) => isOtherProvider(providerId))
    .map(
      ([providerId, models]) =>
        [
          providerId,
          models.filter((model) => isVisibleCatalogModel(providerId, model)),
        ] as [string, LanguageModel[]],
    )
    .filter(([, models]) => models.length > 0);

  const effectiveRecentModels = getEffectiveRecentModels(
    settings.recentModels,
    toRecentModelIdentity(selectedModel),
  );
  const recentModelCandidates = effectiveRecentModels.flatMap<RecentModelEntry>(
    (recentModel) => {
      // Retired claude-code entries from stored recents never resolve.
      if (recentModel.provider === "claude-code") return [];
      if (recentModel.provider === "ollama") {
        if (ollamaError) {
          return [];
        }
        const model = ollamaModels.find(
          (candidate) => candidate.modelName === recentModel.name,
        );
        if (model) {
          return [
            { type: "local" as const, providerId: "ollama" as const, model },
          ];
        }
        return localProvidersLoaded.ollama
          ? []
          : [
              {
                type: "local-loading" as const,
                providerId: "ollama" as const,
                modelName: recentModel.name,
              },
            ];
      }
      if (recentModel.provider === "lmstudio") {
        if (lmStudioError) {
          return [];
        }
        const model = lmStudioModels.find(
          (candidate) => candidate.modelName === recentModel.name,
        );
        if (model) {
          return [
            {
              type: "local" as const,
              providerId: "lmstudio" as const,
              model,
            },
          ];
        }
        return localProvidersLoaded.lmstudio
          ? []
          : [
              {
                type: "local-loading" as const,
                providerId: "lmstudio" as const,
                modelName: recentModel.name,
              },
            ];
      }

      const model = modelsByProviders?.[recentModel.provider]?.find(
        (candidate) =>
          isVisibleCatalogModel(recentModel.provider, candidate) &&
          (recentModel.customModelId
            ? candidate.type === "custom" &&
              candidate.id === recentModel.customModelId
            : candidate.apiName === recentModel.name),
      );
      return model
        ? [
            {
              type: "cloud" as const,
              providerId: recentModel.provider,
              model,
            },
          ]
        : [];
    },
  );
  const recentModelEntries = recentModelCandidates.filter(
    (entry, index, entries) =>
      entries.findIndex(
        (candidate) =>
          candidate.type === entry.type &&
          candidate.providerId === entry.providerId &&
          (candidate.type !== "cloud" ||
            entry.type !== "cloud" ||
            ((candidate as { model: LanguageModel }).model.apiName ===
              (entry as { model: LanguageModel }).model.apiName &&
              (candidate as { model: LanguageModel }).model.id ===
                (entry as { model: LanguageModel }).model.id)),
      ) === index,
  );
  const recentModelsWithoutStaleEntries = effectiveRecentModels.filter(
    (recentModel) => {
      if (recentModel.provider === "claude-code") return false;
      if (recentModel.provider === "ollama") {
        return (
          Boolean(ollamaError) ||
          !localProvidersLoaded.ollama ||
          ollamaModels.some(
            (candidate) => candidate.modelName === recentModel.name,
          )
        );
      }
      if (recentModel.provider === "lmstudio") {
        return (
          Boolean(lmStudioError) ||
          !localProvidersLoaded.lmstudio ||
          lmStudioModels.some(
            (candidate) => candidate.modelName === recentModel.name,
          )
        );
      }
      if (loading || modelsByProvidersError || providersError) {
        return true;
      }
      if (recentModel.customModelId === undefined) {
        // The successful query can still contain the bundled fallback catalog,
        // which is intentionally smaller than the remote catalog. Keep
        // unresolved built-in identities persisted and merely omit their rows.
        return true;
      }
      return (modelsByProviders?.[recentModel.provider] ?? []).some(
        (candidate) =>
          candidate.type === "custom" &&
          candidate.id === recentModel.customModelId,
      );
    },
  );
  const normalizedRecentModels = recentModelsWithoutStaleEntries.map(
    (recentModel) => {
      if (recentModel.customModelId !== undefined) {
        return recentModel;
      }
      const resolvedModel = modelsByProviders?.[recentModel.provider]?.find(
        (candidate) => candidate.apiName === recentModel.name,
      );
      return resolvedModel?.type === "custom" && resolvedModel.id !== undefined
        ? { ...recentModel, customModelId: resolvedModel.id }
        : recentModel;
    },
  );
  const onModelSelect = (params: ModelSelectParams) =>
    performModelSelect({ ...params, recentModels: normalizedRecentModels });

  const getProviderDisplayName = (providerId: string) => {
    const provider = providers?.find((p) => p.id === providerId);
    return provider?.name ?? providerId;
  };

  // Opencode-style: a cloud model is locked when no API key (settings or
  // env) is configured for its provider. Custom and local providers are
  // never locked. While settings/env vars are still loading we can't tell
  // whether a key exists, so fail open rather than flash a lock at
  // env-var-configured users.
  const isModelLocked = (providerId: string, _model: LanguageModel) => {
    if (settingsLoading) {
      return false;
    }
    const provider = providers?.find((p) => p.id === providerId);
    return provider?.type === "cloud" && !isProviderSetup(providerId);
  };

  const handleLockedModelClick = (providerId: string, model: LanguageModel) => {
    posthog.capture("model-picker:locked-model-click", {
      provider: providerId,
      model: model.apiName,
    });
    setOpen(false);
    setUnlockTarget({ providerId, model });
  };

  const handleUnlockDialogOwnKeyClick = () => {
    if (!unlockTarget) {
      return;
    }
    posthog.capture("model-picker:add-own-key-click", {
      provider: unlockTarget.providerId,
    });
    const providerId = unlockTarget.providerId;
    setUnlockTarget(null);
    navigate({
      to: providerSettingsRoute.id,
      params: { provider: providerId },
    });
  };

  const unlockTargetProviderName = unlockTarget
    ? getProviderDisplayName(unlockTarget.providerId)
    : "";

  const handleCloudModelSelect = (
    providerId: string,
    model: LanguageModel,
    effortLevel?: string,
  ) => {
    if (isModelLocked(providerId, model)) {
      handleLockedModelClick(providerId, model);
      return;
    }

    const customModelId = model.type === "custom" ? model.id : undefined;
    void onModelSelect({
      model: {
        name: model.apiName,
        provider: providerId,
        ...(customModelId !== undefined ? { customModelId } : {}),
      },
      catalogModel: model,
      effortLevel,
      rememberEffort: effortLevel !== undefined,
    });
    setOpen(false);
  };

  const renderCloudModelItem = ({
    providerId,
    model,
    showPrice = true,
  }: {
    providerId: string;
    model: LanguageModel;
    showPrice?: boolean;
  }) => {
    const modelRef = {
      name: model.apiName,
      provider: providerId,
      customModelId: model.type === "custom" ? model.id : undefined,
    };
    const isSelected = isSameModel(normalizedSelectedModel, modelRef);
    const modelKey = `${providerId}-${model.apiName}-${modelRef.customModelId ?? "catalog"}`;
    const isLocked = isModelLocked(providerId, model);
    const isFreeProviderRow =
      providerId === "openrouter" && isFreeOpenRouterModelName(model.apiName);
    // Free OpenRouter models may train on your data; surface that inline.
    const shouldShowDataSharingDisclosure = isFreeProviderRow;
    const effortSettings = getEffortSettings(model);
    const currentEffort = isSelected
      ? selectedEffortLevel
      : createModelSelection({
          model: modelRef,
          catalogModel: model,
          preferredEffortLevel:
            settings.modelEffortPreferences?.[getModelPreferenceKey(modelRef)],
        }).effortLevel;
    const effortLabel = formatEffortLevel(currentEffort);
    const compactEffortLabel = formatCompactEffortLevel(currentEffort);
    const unlockedAriaLabel = [
      model.displayName,
      showPrice && model.dollarSigns != null
        ? model.dollarSigns === 0
          ? "Free"
          : `Price: ${(model.dollarSigns / 2).toFixed(1)}`
        : null,
      model.tag,
      isSelected ? "Selected" : null,
      shouldShowDataSharingDisclosure ? "Data sharing" : null,
      `Effort: ${effortLabel}`,
      "Press Enter to select; press Right Arrow to configure effort",
    ]
      .filter(Boolean)
      .join(". ");

    const rowContent = (
      <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <span className="min-w-0 flex items-center gap-2">
          <ProviderIcon providerId={providerId} apiName={model.apiName} />
          <span className="min-w-0 flex flex-col items-start">
            <span
              title={model.description ? undefined : model.displayName}
              className={cn(
                "block max-w-full truncate text-[13px] leading-tight",
                isLocked && "text-muted-foreground",
              )}
            >
              {model.displayName}
            </span>
          </span>
        </span>
        <span className="flex min-w-fit items-center gap-1.5">
          {showPrice && <PriceBadge dollarSigns={model.dollarSigns} />}
          {model.tag && (
            <span
              className={cn(
                PILL_CLASS,
                "bg-primary/10 text-primary",
                model.tagColor,
              )}
            >
              {model.tag}
            </span>
          )}
          {isLocked && (
            <LockIcon className="size-3.5 text-muted-foreground shrink-0" />
          )}
          {isSelected && (
            <CheckIcon className="size-3.5 text-primary shrink-0" />
          )}
          {shouldShowDataSharingDisclosure && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      PILL_CLASS,
                      "bg-amber-500/15 text-amber-700 dark:text-amber-300",
                    )}
                  >
                    Data sharing
                  </span>
                }
              />
              <TooltipContent side="right" align="start">
                Data may be shared with the AI provider and used for training
                models.
              </TooltipContent>
            </Tooltip>
          )}
          {!isLocked && (
            <>
              <span
                data-effort-level
                className="text-xs text-muted-foreground"
                title={
                  model.description
                    ? undefined
                    : `Reasoning effort: ${effortLabel}`
                }
              >
                {compactEffortLabel}
              </span>
              <span
                data-effort-chevron
                className="-mr-1 flex size-6 items-center justify-center rounded-sm hover:bg-muted"
                aria-hidden="true"
              >
                <ChevronRightIcon className="size-4" />
              </span>
            </>
          )}
        </span>
      </div>
    );

    const commonProps = {
      "data-model-provider": providerId,
      "data-model-name": model.apiName,
      "data-locked": isLocked || undefined,
      className: cn(
        "relative px-2 py-1.5",
        isSelected &&
          "bg-primary/8 before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary",
      ),
    };

    const item = isLocked ? (
      <DropdownMenuItem
        key={modelKey}
        {...commonProps}
        aria-label={`${model.displayName} — requires an API key from ${getProviderDisplayName(providerId)}`}
        onClick={() => handleLockedModelClick(providerId, model)}
      >
        {rowContent}
      </DropdownMenuItem>
    ) : (
      <DropdownMenuSubTrigger
        key={modelKey}
        {...commonProps}
        aria-label={`${unlockedAriaLabel}.`}
        hideChevron
        onMouseDown={(event) => {
          if (!isEffortChevronTarget(event.target)) {
            event.preventBaseUIHandler();
          }
        }}
        onClick={(event) => {
          if (!isEffortChevronTarget(event.target)) {
            event.preventBaseUIHandler();
            handleCloudModelSelect(providerId, model);
          }
        }}
      >
        {rowContent}
      </DropdownMenuSubTrigger>
    );

    const itemWithTooltip = model.description ? (
      <Tooltip key={modelKey}>
        <TooltipTrigger render={item} />
        <TooltipContent side="left" align="start">
          <span className="max-w-64">{model.description}</span>
        </TooltipContent>
      </Tooltip>
    ) : (
      item
    );

    if (isLocked) {
      return itemWithTooltip;
    }

    return (
      <DropdownMenuSub key={modelKey}>
        {itemWithTooltip}
        <DropdownMenuSubContent className="w-52">
          <DropdownMenuLabel>Effort</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {effortSettings.possibleEffortLevels.map((effortLevel) => (
            <DropdownMenuItem
              key={effortLevel}
              onClick={() =>
                handleCloudModelSelect(providerId, model, effortLevel)
              }
            >
              <span>{formatEffortLevel(effortLevel)}</span>
              {effortLevel === effortSettings.defaultEffortLevel && (
                <span className="text-xs text-muted-foreground">(default)</span>
              )}
              {effortLevel === currentEffort && (
                <CheckIcon className="ml-auto size-3.5 text-primary" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  };

  const renderProviderSubmenu = (
    providerId: string,
    models: LanguageModel[],
  ) => {
    const visibleModels = models.filter((model) =>
      isVisibleCatalogModel(providerId, model),
    );
    if (visibleModels.length === 0) {
      return null;
    }
    const provider = providers?.find((p) => p.id === providerId);
    const providerDisplayName = getProviderDisplayName(providerId);
    const providerState =
      provider?.type === "custom" ? "Custom provider" : null;

    return (
      <DropdownMenuSub key={providerId}>
        <DropdownMenuSubTrigger
          className="w-full font-normal"
          data-provider-id={providerId}
          aria-label={[
            providerDisplayName,
            providerState,
            formatModelCount(visibleModels.length),
            "Opens submenu",
          ]
            .filter(Boolean)
            .join(". ")}
          {...NAVIGATION_SUBMENU_HOVER_PROPS}
        >
          <div className="flex flex-col items-start w-full">
            <div className="flex items-center gap-2">
              <span>{providerDisplayName}</span>
              {provider?.type === "custom" && (
                <span className={cn(PILL_CLASS, "bg-amber-500 text-white")}>
                  Custom
                </span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              {formatModelCount(visibleModels.length)}
            </span>
          </div>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          className={cn(MODEL_MENU_WIDTH_CLASS, SCROLL_AREA_CLASS)}
          data-testid={`other-provider-models-${providerId}`}
        >
          <DropdownMenuLabel>
            {providerDisplayName + " Models"}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {visibleModels.map((model) =>
            renderCloudModelItem({ providerId, model }),
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  };

  const renderLocalModelItem = (
    providerId: "ollama" | "lmstudio",
    model: LocalModel,
  ) => {
    const modelRef = { name: model.modelName, provider: providerId };
    const isSelected =
      selectedModel.provider === providerId &&
      selectedModel.name === model.modelName;
    const effortSettings = getEffortSettings(undefined, providerId);
    const currentEffort = isSelected
      ? selectedEffortLevel
      : createModelSelection({
          model: modelRef,
          preferredEffortLevel:
            settings.modelEffortPreferences?.[getModelPreferenceKey(modelRef)],
        }).effortLevel;
    const effortLabel = formatEffortLevel(currentEffort);
    const compactEffortLabel = formatCompactEffortLevel(currentEffort);
    const selectLocalModel = (effortLevel?: string) => {
      void onModelSelect({
        model: modelRef,
        effortLevel,
        rememberEffort: effortLevel !== undefined,
      });
      setOpen(false);
    };

    return (
      <DropdownMenuSub key={`${providerId}-${model.modelName}`}>
        <DropdownMenuSubTrigger
          hideChevron
          aria-label={`${model.displayName}. Effort: ${effortLabel}. Press Enter to select; press Right Arrow to configure effort.`}
          className={cn(
            "relative py-1.5 w-full",
            isSelected &&
              "bg-primary/8 before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-r-full before:bg-primary",
          )}
          onMouseDown={(event) => {
            if (!isEffortChevronTarget(event.target)) {
              event.preventBaseUIHandler();
            }
          }}
          onClick={(event) => {
            if (!isEffortChevronTarget(event.target)) {
              event.preventBaseUIHandler();
              selectLocalModel();
            }
          }}
        >
          <div className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <ProviderIcon providerId={providerId} />
              <div className="min-w-0 flex flex-col items-start">
                <span
                  className="block max-w-full truncate text-[13px] leading-tight"
                  title={model.displayName}
                >
                  {model.displayName}
                </span>
                <span
                  className="block max-w-full truncate text-xs text-muted-foreground"
                  title={model.modelName}
                >
                  {model.modelName}
                </span>
              </div>
            </div>
            <div className="flex min-w-fit items-center gap-1.5">
              {isSelected && (
                <CheckIcon className="size-3.5 shrink-0 text-primary" />
              )}
              <span
                data-effort-level
                className="text-xs text-muted-foreground"
                title={`Reasoning effort: ${effortLabel}`}
              >
                {compactEffortLabel}
              </span>
              <span
                data-effort-chevron
                className="-mr-1 flex size-6 items-center justify-center rounded-sm hover:bg-muted"
                aria-hidden="true"
              >
                <ChevronRightIcon className="size-4" />
              </span>
            </div>
          </div>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-52">
          <DropdownMenuLabel>Effort</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {effortSettings.possibleEffortLevels.map((effortLevel) => (
            <DropdownMenuItem
              key={effortLevel}
              onClick={() => selectLocalModel(effortLevel)}
            >
              <span>{formatEffortLevel(effortLevel)}</span>
              {effortLevel === effortSettings.defaultEffortLevel && (
                <span className="text-xs text-muted-foreground">(default)</span>
              )}
              {effortLevel === currentEffort && (
                <CheckIcon className="ml-auto size-3.5 text-primary" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  };

  const renderLocalProviderSubmenu = ({
    providerId,
    label,
    models,
    loading: localLoading,
    error,
  }: {
    providerId: "ollama" | "lmstudio";
    label: string;
    models: LocalModel[];
    loading: boolean;
    error: Error | null;
  }) => {
    const hasModels = !localLoading && !error && models.length > 0;
    const statusLabel = localLoading
      ? "Loading"
      : error
        ? "Error loading"
        : hasModels
          ? formatModelCount(models.length)
          : "None available";

    return (
      <DropdownMenuSub key={providerId}>
        <DropdownMenuSubTrigger
          disabled={localLoading && models.length === 0}
          className="w-full font-normal"
          aria-label={`${label}. ${statusLabel}. Opens submenu`}
          {...NAVIGATION_SUBMENU_HOVER_PROPS}
        >
          <div className="flex flex-col items-start">
            <span>{label}</span>
            {localLoading ? (
              <span className="text-xs text-muted-foreground">Loading...</span>
            ) : error ? (
              <span className="text-xs text-red-500">Error loading</span>
            ) : !hasModels ? (
              <span className="text-xs text-muted-foreground">
                None available
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">
                {formatModelCount(models.length)}
              </span>
            )}
          </div>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          className={cn(MODEL_MENU_WIDTH_CLASS, SCROLL_AREA_CLASS)}
        >
          <DropdownMenuLabel>{label} Models</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {localLoading && models.length === 0 ? (
            <div className="text-xs text-center py-2 text-muted-foreground">
              Loading models...
            </div>
          ) : error ? (
            <div className="px-2 py-1.5 text-sm text-red-600">
              <div className="flex flex-col">
                <span>Error loading models</span>
                <span className="text-xs text-muted-foreground">
                  {providerId === "ollama"
                    ? "Is Ollama running?"
                    : error.message}
                </span>
              </div>
            </div>
          ) : !hasModels ? (
            <div className="px-2 py-1.5 text-sm">
              <div className="flex flex-col">
                <span>No local models found</span>
                <span className="text-xs text-muted-foreground">
                  {providerId === "ollama"
                    ? "Ensure Ollama is running and models are pulled."
                    : "Ensure LM Studio is running and models are loaded."}
                </span>
              </div>
            </div>
          ) : (
            models.map((model) => renderLocalModelItem(providerId, model))
          )}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  };

  const cloudCatalogGroups = PRICE_TIERS.map((tier) => ({
    tier,
    entries: primaryModelEntries
      .filter((entry) => tierFor(entry.model.dollarSigns) === tier)
      .sort(
        (a, b) =>
          (a.providerId === "openai" ? 0 : 1) -
          (b.providerId === "openai" ? 0 : 1),
      ),
  })).filter((group) => group.entries.length > 0);
  const hasCloudCatalogEntries =
    cloudCatalogGroups.length > 0 || otherProviderEntries.length > 0;
  const cloudCatalogError = modelsByProvidersError ?? providersError;
  const pendingModelName = pendingBackend
    ? getModelDisplayName(pendingBackend.model)
    : "";
  const newChatExplanation = `This conversation can't continue with ${pendingModelName}.`;

  return (
    <>
      <Dialog
        open={pendingBackend !== null}
        onOpenChange={(value) => {
          if (!value && !confirmBackend.isPending) {
            confirmBackend.reset();
            setPendingBackend(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {`Start a new chat with ${pendingModelName}?`}
            </DialogTitle>
            <DialogDescription>
              {`${newChatExplanation} Your current chat will be saved, but its messages won’t carry over.`}
            </DialogDescription>
          </DialogHeader>
          {confirmBackend.error && (
            <p role="alert">{confirmBackend.error.message}</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              className="focus-visible:ring-2"
              disabled={confirmBackend.isPending}
              onClick={() => {
                confirmBackend.reset();
                setPendingBackend(null);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={confirmBackend.isPending}
              onClick={() => confirmBackend.mutate()}
            >
              Start new chat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger
          disabled={isChatRoute && chatId != null && chatLoading}
          className="inline-flex items-center justify-center whitespace-nowrap rounded-lg text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border-none bg-transparent shadow-none text-foreground/80 hover:text-foreground hover:bg-muted/60 h-7 max-w-[220px] px-2 gap-1.5 cursor-pointer"
          data-testid="model-picker"
          title={modelDisplayName}
        >
          <span className="truncate">{modelDisplayName}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent className={MODEL_MENU_WIDTH_CLASS} align="start">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              className="w-full font-normal"
              {...NAVIGATION_SUBMENU_HOVER_PROPS}
            >
              <span>All models</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              className={cn(MODEL_MENU_WIDTH_CLASS, SCROLL_AREA_CLASS)}
              data-testid="more-models-submenu"
              data-catalog-loading={loading}
            >
              <DropdownMenuLabel>All models</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {loading ? (
                <div className="text-xs text-center py-2 text-muted-foreground">
                  Loading cloud models...
                </div>
              ) : !hasCloudCatalogEntries ? (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">
                  {cloudCatalogError
                    ? "Couldn’t load cloud models"
                    : "No cloud models available"}
                </div>
              ) : (
                <>
                  {(() => {
                    const nodes: ReactNode[] = [];
                    cloudCatalogGroups.forEach(({ tier, entries }, index) => {
                      if (index > 0) {
                        nodes.push(
                          <DropdownMenuSeparator
                            key={`tier-sep-${tier.label}`}
                          />,
                        );
                      }
                      nodes.push(
                        <div
                          key={`tier-label-${tier.label}`}
                          className="flex items-center gap-1.5 px-2 pt-1.5 pb-1"
                        >
                          <span className="text-[10px] uppercase tracking-wider font-medium text-muted-foreground shrink-0">
                            {tier.label}
                          </span>
                          <span
                            aria-hidden="true"
                            className="size-[3px] rounded-full bg-muted-foreground/50 shrink-0"
                          />
                          <span className="text-[11px] text-muted-foreground/85 truncate">
                            {tier.caption}
                          </span>
                        </div>,
                      );
                      entries.forEach(({ providerId, model }) => {
                        nodes.push(renderCloudModelItem({ providerId, model }));
                      });
                    });
                    return nodes;
                  })()}
                </>
              )}
              <DropdownMenuSeparator />
              <div
                className="px-2 pt-1.5 pb-1 text-[10px] uppercase tracking-wider font-medium text-muted-foreground"
                data-testid="local-providers-section"
              >
                Local providers
              </div>
              {renderLocalProviderSubmenu({
                providerId: "ollama",
                label: "Ollama",
                models: ollamaModels,
                loading: ollamaLoading,
                error: ollamaError,
              })}
              {renderLocalProviderSubmenu({
                providerId: "lmstudio",
                label: "LM Studio",
                models: lmStudioModels,
                loading: lmStudioLoading,
                error: lmStudioError,
              })}
              {otherProviderEntries.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <div
                    className="px-2 pt-1.5 pb-1 text-[10px] uppercase tracking-wider font-medium text-muted-foreground"
                    data-testid="cloud-providers-section"
                  >
                    Cloud providers
                  </div>
                  {otherProviderEntries.map(([providerId, models]) =>
                    renderProviderSubmenu(providerId, models),
                  )}
                </>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          {loading ? (
            <div className="text-xs text-center py-2 text-muted-foreground">
              Loading models...
            </div>
          ) : (
            <>
              {cloudCatalogError && (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">
                  Couldn’t load cloud models
                </div>
              )}

              {recentModelEntries.length > 0 && (
                <>
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Recent
                  </DropdownMenuLabel>
                  {recentModelEntries.map((entry) => {
                    if (entry.type === "cloud") {
                      return renderCloudModelItem({
                        providerId: entry.providerId,
                        model: entry.model,
                      });
                    }
                    if (entry.type === "local") {
                      return renderLocalModelItem(
                        entry.providerId,
                        entry.model,
                      );
                    }
                    return (
                      <DropdownMenuItem
                        key={`${entry.providerId}-${entry.modelName}-loading`}
                        disabled
                        aria-label={`${entry.modelName}. Loading local model`}
                        className="py-1.5"
                      >
                        <ProviderIcon providerId={entry.providerId} />
                        <span className="min-w-0 truncate text-[13px]">
                          {entry.modelName}
                        </span>
                        <span className="ml-auto text-xs text-muted-foreground">
                          Loading...
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Unlock dialog for locked models */}
      <Dialog
        open={unlockTarget !== null}
        onOpenChange={(dialogOpen) => {
          if (!dialogOpen) {
            setUnlockTarget(null);
          }
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          data-testid="unlock-model-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              Use {unlockTarget?.model.displayName} with your own{" "}
              {unlockTargetProviderName} API key
            </DialogTitle>
            <DialogDescription>
              Add an API key in provider settings to use this model.
            </DialogDescription>
          </DialogHeader>
          <Button
            className="cursor-pointer w-full"
            onClick={handleUnlockDialogOwnKeyClick}
          >
            Add {unlockTargetProviderName} API key
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
