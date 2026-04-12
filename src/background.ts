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
  ensureContentScript,
  getExtensionStatus,
  triggerActiveTabImmersive
} from "./background-runtime";
import type {
  ExtensionSettings,
  ReadingCoachmarkStatus,
  RuntimeMessage,
  TranslationFailure,
  TranslationMeta,
  TranslationResponse
} from "./shared/types";

const MENU_ID = "litetrace-open-options";
const requestCache = new Map<
  string,
  Promise<{ translations: string[]; meta: TranslationMeta }>
>();

function buildCacheKey(settings: ExtensionSettings, texts: string[]): string {
  return JSON.stringify({
    provider: settings.activeProvider,
    baseUrl: settings.openai.baseUrl,
    model: settings.openai.model,
    texts
  });
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
  settingsOverride?: ExtensionSettings
): Promise<TranslationResponse> {
  try {
    const settings = await resolveSettings(settingsOverride);
    const cacheKey = buildCacheKey(settings, texts);

    const cachedRequest = requestCache.get(cacheKey);
    if (cachedRequest) {
      const cachedResult = await cachedRequest;
      return {
        ok: true,
        translations: cachedResult.translations,
        meta: cachedResult.meta
      };
    }

    const pending = translateTextsDetailed(texts, settings);
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
    return toFailure(error);
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
      id: MENU_ID,
      title: "打开浅译设置",
      contexts: ["action"]
    });
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_ID) {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: RuntimeMessage,
    _sender,
    sendResponse: (response?: unknown) => void
  ) => {
    void (async () => {
      switch (message.type) {
        case "TRANSLATE_PAGE_BLOCKS": {
          sendResponse(
            await handleTranslation(
              message.payload.texts,
              message.payload.settingsOverride
            )
          );
          return;
        }

        case "TRANSLATE_SELECTION": {
          sendResponse(
            await handleTranslation(
              message.payload.texts,
              message.payload.settingsOverride
            )
          );
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
