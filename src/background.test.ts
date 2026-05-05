import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mergeSettings } from "./shared/settings";
import type { RuntimeMessage } from "./shared/types";

const {
  getExtensionStatusMock,
  getSettingsMock,
  saveSettingsMock,
  translateTextsDetailedMock,
  triggerActiveTabImmersiveMock,
  triggerTabGlossaryTermEditorMock,
  triggerTabSelectionTranslationMock
} = vi.hoisted(() => ({
  getExtensionStatusMock: vi.fn(),
  getSettingsMock: vi.fn(),
  saveSettingsMock: vi.fn(),
  translateTextsDetailedMock: vi.fn(),
  triggerActiveTabImmersiveMock: vi.fn(),
  triggerTabGlossaryTermEditorMock: vi.fn(),
  triggerTabSelectionTranslationMock: vi.fn()
}));

vi.mock("./background-runtime", () => ({
  getExtensionStatus: getExtensionStatusMock,
  triggerActiveTabImmersive: triggerActiveTabImmersiveMock,
  triggerTabGlossaryTermEditor: triggerTabGlossaryTermEditorMock,
  triggerTabSelectionTranslation: triggerTabSelectionTranslationMock
}));

vi.mock("./shared/storage", () => ({
  getSettings: getSettingsMock,
  saveSettings: saveSettingsMock
}));

vi.mock("./shared/providers", () => {
  class TranslationProviderError extends Error {
    readonly details: {
      code: string;
      message: string;
      action?: "open-options";
    };

    constructor(details: { code: string; message: string; action?: "open-options" }) {
      super(details.message);
      this.name = "TranslationProviderError";
      this.details = details;
    }
  }

  return {
    translateTextsDetailed: translateTextsDetailedMock,
    TranslationProviderError
  };
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

const googleSettings = mergeSettings({
  activeProvider: "google",
  google: {
    apiKey: "demo-key"
  }
});

describe("background message handlers", () => {
  let onMessageListener:
    | ((message: RuntimeMessage, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean)
    | null;
  let onInstalledListener: (() => void) | null;
  let onContextMenuClickedListener:
    | ((info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void)
    | null;

  beforeEach(() => {
    vi.resetModules();
    onMessageListener = null;
    onInstalledListener = null;
    onContextMenuClickedListener = null;
    translateTextsDetailedMock.mockReset();
    getSettingsMock.mockReset();
    saveSettingsMock.mockReset();
    getExtensionStatusMock.mockReset();
    triggerActiveTabImmersiveMock.mockReset();
    triggerTabGlossaryTermEditorMock.mockReset();
    triggerTabSelectionTranslationMock.mockReset();
    triggerActiveTabImmersiveMock.mockResolvedValue({ ok: true });
    triggerTabGlossaryTermEditorMock.mockResolvedValue({ ok: true });
    triggerTabSelectionTranslationMock.mockResolvedValue({ ok: true });

    vi.stubGlobal("chrome", {
      contextMenus: {
        removeAll: vi.fn((callback?: () => void) => callback?.()),
        create: vi.fn(),
        onClicked: {
          addListener: vi.fn(
            (listener: (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void) => {
              onContextMenuClickedListener = listener;
            }
          )
        }
      },
      runtime: {
        onInstalled: {
          addListener: vi.fn((listener: () => void) => {
            onInstalledListener = listener;
          })
        },
        onMessage: {
          addListener: vi.fn(
            (
              listener: (
                message: RuntimeMessage,
                sender: chrome.runtime.MessageSender,
                sendResponse: (response?: unknown) => void
              ) => boolean
            ) => {
              onMessageListener = listener;
            }
          )
        },
        openOptionsPage: vi.fn().mockResolvedValue(undefined)
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function loadBackgroundModule(): Promise<void> {
    await import("./background");
    expect(onMessageListener).not.toBeNull();
  }

  async function dispatchRuntimeMessage(
    message: RuntimeMessage,
    sender: chrome.runtime.MessageSender = { tab: { id: 99 } as chrome.tabs.Tab }
  ): Promise<unknown> {
    return await new Promise((resolve) => {
      const keepAlive = onMessageListener?.(message, sender, resolve);
      expect(keepAlive).toBe(true);
    });
  }

  it("reuses the shared request cache for non-immersive translation messages", async () => {
    const deferred = createDeferred<{
      translations: string[];
      meta: {
        cacheHits: number;
        requestedCount: number;
        networkCount: number;
      };
    }>();

    translateTextsDetailedMock.mockReturnValue(deferred.promise);

    await loadBackgroundModule();

    const message: RuntimeMessage = {
      type: "TRANSLATE_SELECTION",
      payload: {
        texts: ["Hello"],
        settingsOverride: googleSettings
      }
    };

    const firstResponse = dispatchRuntimeMessage(message);
    const secondResponse = dispatchRuntimeMessage(message);

    await vi.waitFor(() => {
      expect(translateTextsDetailedMock).toHaveBeenCalledTimes(1);
    });

    deferred.resolve({
      translations: ["你好"],
      meta: {
        cacheHits: 0,
        requestedCount: 1,
        networkCount: 1
      }
    });

    await expect(Promise.all([firstResponse, secondResponse])).resolves.toEqual([
      {
        ok: true,
        translations: ["你好"],
        meta: {
          cacheHits: 0,
          requestedCount: 1,
          networkCount: 1
        }
      },
      {
        ok: true,
        translations: ["你好"],
        meta: {
          cacheHits: 0,
          requestedCount: 1,
          networkCount: 1
        }
      }
    ]);
  });

  it("bypasses the shared request cache for immersive page batches", async () => {
    const deferred = createDeferred<{
      translations: string[];
      meta: {
        cacheHits: number;
        requestedCount: number;
        networkCount: number;
      };
    }>();

    translateTextsDetailedMock.mockReturnValue(deferred.promise);

    await loadBackgroundModule();

    const message: RuntimeMessage = {
      type: "TRANSLATE_PAGE_BLOCKS",
      payload: {
        texts: ["Hello"],
        settingsOverride: googleSettings,
        immersiveJobId: 7
      }
    };

    const firstResponse = dispatchRuntimeMessage(message);
    const secondResponse = dispatchRuntimeMessage(message);

    await vi.waitFor(() => {
      expect(translateTextsDetailedMock).toHaveBeenCalledTimes(2);
    });

    deferred.resolve({
      translations: ["你好"],
      meta: {
        cacheHits: 0,
        requestedCount: 1,
        networkCount: 1
      }
    });

    await expect(Promise.all([firstResponse, secondResponse])).resolves.toEqual([
      {
        ok: true,
        translations: ["你好"],
        meta: {
          cacheHits: 0,
          requestedCount: 1,
          networkCount: 1
        }
      },
      {
        ok: true,
        translations: ["你好"],
        meta: {
          cacheHits: 0,
          requestedCount: 1,
          networkCount: 1
        }
      }
    ]);
  });

  it("aborts immersive page-batch requests when cancellation is requested", async () => {
    let observedSignal: AbortSignal | undefined;

    translateTextsDetailedMock.mockImplementation(
      async (
        _texts: string[],
        _settings: unknown,
        _fetcher: typeof fetch,
        _permissionsChecked: boolean,
        signal?: AbortSignal
      ) => {
        observedSignal = signal;

        return await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
    );

    await loadBackgroundModule();

    const message: RuntimeMessage = {
      type: "TRANSLATE_PAGE_BLOCKS",
      payload: {
        texts: ["Hello"],
        settingsOverride: googleSettings,
        immersiveJobId: 12
      }
    };

    const translationResponse = dispatchRuntimeMessage(message);

    await vi.waitFor(() => {
      expect(translateTextsDetailedMock).toHaveBeenCalledTimes(1);
      expect(observedSignal).toBeDefined();
    });

    await expect(
      dispatchRuntimeMessage({
        type: "CANCEL_IMMERSIVE_TRANSLATION",
        payload: {
          immersiveJobId: 12
        }
      })
    ).resolves.toEqual({ ok: true });

    await vi.waitFor(() => {
      expect(observedSignal?.aborted).toBe(true);
    });

    await expect(translationResponse).resolves.toMatchObject({
      ok: false,
      error: {
        message: "翻译已取消。"
      }
    });
  });

  it("registers action and selection context menus on install", async () => {
    await loadBackgroundModule();

    onInstalledListener?.();

    expect(chrome.contextMenus.create).toHaveBeenCalledWith({
      id: "litetrace-open-options",
      title: "打开浅译设置",
      contexts: ["action"]
    });
    expect(chrome.contextMenus.create).toHaveBeenCalledWith({
      id: "litetrace-add-glossary-term",
      title: "加入浅译术语",
      contexts: ["selection"]
    });
  });

  it("routes the selection context menu to the glossary editor helper", async () => {
    await loadBackgroundModule();

    onContextMenuClickedListener?.(
      {
        menuItemId: "litetrace-add-glossary-term",
        selectionText: "Hello world"
      } as chrome.contextMenus.OnClickData,
      {
        id: 88,
        url: "https://example.com"
      } as chrome.tabs.Tab
    );

    await vi.waitFor(() => {
      expect(triggerTabGlossaryTermEditorMock).toHaveBeenCalledWith(88, "Hello world");
    });
  });
});
