import {
  getCurrentProviderLabel,
  isProviderConfigured
} from "./shared/settings";
import { TranslationProviderError } from "./shared/providers";
import { getSettings } from "./shared/storage";
import type { ExtensionStatus } from "./shared/types";

const HTTP_PREFIX = /^https?:\/\//i;

interface PageImmersiveStateResponse {
  ok?: boolean;
  immersiveActive?: boolean;
}

async function injectContentScript(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

async function sendTabMessageWithRecovery<TResponse>(
  tabId: number,
  message: { type: string }
): Promise<TResponse> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as TResponse;
  } catch {
    await injectContentScript(tabId);

    try {
      return (await chrome.tabs.sendMessage(tabId, message)) as TResponse;
    } catch {
      throw new Error("当前页面没有成功连接 LiteTrace，请刷新页面后再试一次。");
    }
  }
}

export async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await sendTabMessageWithRecovery(tabId, { type: "PING" });
  } catch {
    throw new Error("LiteTrace 没有成功注入当前页面，请刷新页面后再试一次。");
  }
}

export async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [currentWindowTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (currentWindowTab) {
    return currentWindowTab;
  }

  const [lastFocusedTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  return lastFocusedTab ?? null;
}

export function isSupportedTab(tab: chrome.tabs.Tab | null): boolean {
  return Boolean(tab?.id && tab.url && HTTP_PREFIX.test(tab.url));
}

export async function getActiveTabImmersiveState(
  tab: chrome.tabs.Tab | null
): Promise<boolean> {
  if (!isSupportedTab(tab) || !tab?.id) {
    return false;
  }

  try {
    await ensureContentScript(tab.id);
    const response = (await sendTabMessageWithRecovery<PageImmersiveStateResponse>(tab.id, {
      type: "GET_PAGE_IMMERSIVE_STATE"
    })) as PageImmersiveStateResponse | undefined;
    return Boolean(response?.immersiveActive);
  } catch {
    return false;
  }
}

export async function getExtensionStatus(): Promise<ExtensionStatus> {
  const [settings, tab] = await Promise.all([getSettings(), getActiveTab()]);
  const configured = isProviderConfigured(settings);

  return {
    configured,
    providerLabel: getCurrentProviderLabel(settings.activeProvider),
    hasCompletedSetup: settings.preferences.hasCompletedSetup,
    activeTabSupported: isSupportedTab(tab),
    activeTabImmersiveActive: configured
      ? await getActiveTabImmersiveState(tab)
      : false
  };
}

export async function triggerActiveTabImmersive(): Promise<{ ok: true }> {
  const [settings, tab] = await Promise.all([getSettings(), getActiveTab()]);

  if (!isProviderConfigured(settings)) {
    throw new TranslationProviderError({
      code: "CONFIG_MISSING",
      message: `当前未完成 ${getCurrentProviderLabel(
        settings.activeProvider
      )} 配置，请先在设置页填写并保存。`,
      action: "open-options"
    });
  }

  if (!isSupportedTab(tab) || !tab?.id) {
    throw new Error("当前标签页不支持开启沉浸阅读，请切换到普通网页后重试。");
  }

  await ensureContentScript(tab.id);
  await sendTabMessageWithRecovery(tab.id, {
    type: "TOGGLE_IMMERSIVE_TRANSLATION"
  });

  return { ok: true };
}
