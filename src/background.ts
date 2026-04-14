import {
  getCurrentProviderLabel,
  isProviderConfigured,
  mergeSettings
} from "./shared/settings";
import {
  translateTextsDetailed,
  TranslationProviderError
} from "./shared/providers";
import { getSettings, saveSettings } from "./shared/storage";
import {
  getExtensionStatus,
  triggerActiveTabImmersive,
  triggerTabSelectionTranslation
} from "./background-runtime";
import type {
  ExtensionSettings,
  ReadingCoachmarkStatus,
  RuntimeMessage,
  TranslationFailure,
  TranslationMeta,
  TranslationResponse,
  TranslationScene
} from "./shared/types";

const ACTION_MENU_ID = "litetrace-open-options";
const SELECTION_MENU_ID = "litetrace-translate-selection";
const requestCache = new Map<
  string,
  Promise<{ translations: string[]; meta: TranslationMeta }>
>();
const immersiveRequestControllers = new Map<string, Set<AbortController>>();

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function buildImmersiveRequestKey(
  sender: chrome.runtime.MessageSender,
  immersiveJobId: number
): string | null {
  return typeof sender.tab?.id === "number"
    ? `${sender.tab.id}:${immersiveJobId}`
    : null;
}

function registerImmersiveController(
  requestKey: string,
  controller: AbortController
): void {
  const existing = immersiveRequestControllers.get(requestKey);

  if (existing) {
    existing.add(controller);
    return;
  }

  immersiveRequestControllers.set(requestKey, new Set([controller]));
}

function unregisterImmersiveController(
  requestKey: string,
  controller: AbortController
): void {
  const controllers = immersiveRequestControllers.get(requestKey);

  if (!controllers) {
    return;
  }

  controllers.delete(controller);

  if (controllers.size === 0) {
    immersiveRequestControllers.delete(requestKey);
  }
}

function cancelImmersiveControllers(requestKey: string | null): void {
  if (!requestKey) {
    return;
  }

  const controllers = immersiveRequestControllers.get(requestKey);

  if (!controllers) {
    return;
  }

  immersiveRequestControllers.delete(requestKey);

  for (const controller of controllers) {
    controller.abort();
  }
}

function toFailure(error: unknown): TranslationFailure {
  if (error instanceof TranslationProviderError) {
    return {
      ok: false,
      error: error.details
    };
  }

  if (error instanceof Error && error.message.trim()) {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_ERROR",
        message: error.message
      }
    };
  }

  return {
    ok: false,
    error: {
      code: "UNKNOWN_ERROR",
      message: "发生了未预期的错误，请稍后重试。"
    }
  };
}

async function resolveSettings(
  override?: ExtensionSettings
): Promise<ExtensionSettings> {
  const baseSettings = override ?? (await getSettings());
  const settings = mergeSettings(baseSettings);

  if (!isProviderConfigured(settings)) {
    throw new TranslationProviderError({
      code: "CONFIG_MISSING",
      message: `当前未完成 ${getCurrentProviderLabel(
        settings.activeProvider
      )} 配置，请先在设置页填写并保存。`,
      action: "open-options"
    });
  }

  return settings;
}

async function handleTranslation(
  texts: string[],
  scene: TranslationScene,
  settingsOverride?: ExtensionSettings,
  signal?: AbortSignal,
  useRequestCache = true
): Promise<TranslationResponse> {
  try {
    const settings = await resolveSettings(settingsOverride);
    const cacheKey = useRequestCache
      ? JSON.stringify({
          provider: settings.activeProvider,
          baseUrl: settings.openai.baseUrl,
          model: settings.openai.model,
          scene,
          texts
        })
      : null;

    if (cacheKey) {
      const cachedRequest = requestCache.get(cacheKey);
      if (cachedRequest) {
        const cachedResult = await cachedRequest;
        return {
          ok: true,
          translations: cachedResult.translations,
          meta: cachedResult.meta
        };
      }
    }

    const pending = translateTextsDetailed(
      texts,
      settings,
      fetch,
      false,
      signal,
      scene
    );

    if (!cacheKey) {
      const result = await pending;
      return {
        ok: true,
        translations: result.translations,
        meta: result.meta
      };
    }

    requestCache.set(cacheKey, pending);

    try {
      const result = await pending;
      return {
        ok: true,
        translations: result.translations,
        meta: result.meta
      };
    } finally {
      requestCache.delete(cacheKey);
    }
  } catch (error) {
    if (isAbortError(error)) {
      return toFailure(new Error("翻译已取消。"));
    }

    return toFailure(error);
  }
}

async function handleImmersiveTranslation(
  texts: string[],
  sender: chrome.runtime.MessageSender,
  settingsOverride?: ExtensionSettings,
  immersiveJobId?: number
): Promise<TranslationResponse> {
  if (typeof immersiveJobId !== "number") {
    return handleTranslation(texts, "page", settingsOverride);
  }

  const requestKey = buildImmersiveRequestKey(sender, immersiveJobId);

  if (!requestKey) {
    return handleTranslation(texts, "page", settingsOverride);
  }

  const controller = new AbortController();
  registerImmersiveController(requestKey, controller);

  try {
    return await handleTranslation(
      texts,
      "page",
      settingsOverride,
      controller.signal,
      false
    );
  } finally {
    unregisterImmersiveController(requestKey, controller);
  }
}

async function getReadingCoachmarkStatus(): Promise<ReadingCoachmarkStatus> {
  const settings = await getSettings();

  return {
    shouldShow:
      settings.preferences.hasCompletedSetup &&
      !settings.preferences.hasSeenReadingCoachmark
  };
}

async function markReadingCoachmarkSeen(): Promise<{ ok: true }> {
  const settings = await getSettings();
  settings.preferences.hasSeenReadingCoachmark = true;
  await saveSettings(settings);
  return { ok: true };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: ACTION_MENU_ID,
      title: "打开浅译设置",
      contexts: ["action"]
    });
    chrome.contextMenus.create({
      id: SELECTION_MENU_ID,
      title: "翻译所选内容",
      contexts: ["selection"]
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === ACTION_MENU_ID) {
    void chrome.runtime.openOptionsPage();
    return;
  }

  if (info.menuItemId === SELECTION_MENU_ID && typeof tab?.id === "number") {
    void triggerTabSelectionTranslation(tab.id, info.selectionText).catch(() => {
      // Ignore menu-trigger transport failures; the content script handles in-page feedback.
    });
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: RuntimeMessage,
    sender,
    sendResponse: (response?: unknown) => void
  ) => {
    void (async () => {
      switch (message.type) {
        case "TRANSLATE_PAGE_BLOCKS": {
          sendResponse(
            await handleImmersiveTranslation(
              message.payload.texts,
              sender,
              message.payload.settingsOverride,
              message.payload.immersiveJobId
            )
          );
          return;
        }

        case "TRANSLATE_SELECTION": {
          sendResponse(
            await handleTranslation(
              message.payload.texts,
              "selection",
              message.payload.settingsOverride
            )
          );
          return;
        }

        case "CANCEL_IMMERSIVE_TRANSLATION": {
          cancelImmersiveControllers(
            buildImmersiveRequestKey(sender, message.payload.immersiveJobId)
          );
          sendResponse({ ok: true });
          return;
        }

        case "OPEN_OPTIONS": {
          await chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          return;
        }

        case "GET_EXTENSION_STATUS": {
          sendResponse(await getExtensionStatus());
          return;
        }

        case "TRIGGER_ACTIVE_TAB_IMMERSIVE": {
          try {
            sendResponse(await triggerActiveTabImmersive());
          } catch (error) {
            sendResponse(
              toFailure(
                error instanceof Error
                  ? error
                  : new Error("无法切换当前页面的沉浸阅读状态。")
              )
            );
          }
          return;
        }

        case "GET_READING_COACHMARK_STATUS": {
          sendResponse(await getReadingCoachmarkStatus());
          return;
        }

        case "MARK_READING_COACHMARK_SEEN": {
          sendResponse(await markReadingCoachmarkSeen());
          return;
        }

        default:
          sendResponse(toFailure(new Error("Unsupported message type.")));
      }
    })();

    return true;
  }
);
