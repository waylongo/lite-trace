import "./options.css";

import {
  getCurrentProviderLabel,
  getPermissionOriginsForProvider,
  mergeSettings,
  normalizeOpenAIBaseUrl,
  validateSettings
} from "./shared/settings";
import { getSettings, saveSettings } from "./shared/storage";
import type { ExtensionSettings, RuntimeMessage, TranslationResponse } from "./shared/types";

const providerButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-provider-tab]")
);
const providerPanes = Array.from(
  document.querySelectorAll<HTMLElement>("[data-provider-pane]")
);

const form = document.getElementById("settings-form") as HTMLFormElement;
const feedback = document.getElementById("feedback") as HTMLDivElement;
const activeProviderLabel = document.getElementById("active-provider-label") as HTMLDivElement;
const saveButton = document.getElementById("save-button") as HTMLButtonElement;
const verifyButton = document.getElementById("verify-button") as HTMLButtonElement;
const finishButton = document.getElementById("finish-button") as HTMLButtonElement;
const successPanel = document.getElementById("success-panel") as HTMLElement;
const successTitle = document.getElementById("success-title") as HTMLHeadingElement;
const successDescription = document.getElementById("success-description") as HTMLParagraphElement;

const stepProviderStatus = document.getElementById("step-provider-status") as HTMLParagraphElement;
const stepFieldsStatus = document.getElementById("step-fields-status") as HTMLParagraphElement;
const stepConnectionStatus = document.getElementById(
  "step-connection-status"
) as HTMLParagraphElement;
const stepFinishStatus = document.getElementById("step-finish-status") as HTMLParagraphElement;

const googleApiKeyInput = document.getElementById("google-api-key") as HTMLInputElement;
const openAIBaseUrlInput = document.getElementById("openai-base-url") as HTMLInputElement;
const openAIModelInput = document.getElementById("openai-model") as HTMLInputElement;
const openAIApiKeyInput = document.getElementById("openai-api-key") as HTMLInputElement;

let activeProvider: ExtensionSettings["activeProvider"] = "google";
let persistedSettings = mergeSettings({});
let permissionCheckToken = 0;
let isSubmitting = false;

function setFeedback(message: string, tone: "default" | "success" | "error" = "default"): void {
  feedback.textContent = message;

  if (tone === "default") {
    feedback.removeAttribute("data-tone");
    return;
  }

  feedback.dataset.tone = tone;
}

function setButtonsDisabled(disabled: boolean): void {
  saveButton.disabled = disabled;
  verifyButton.disabled = disabled;
}

function setSuccessPanel(
  visible: boolean,
  title = "完成",
  description = "返回网页后，点击图标即可开始。"
): void {
  successPanel.hidden = !visible;
  successTitle.textContent = title;
  successDescription.textContent = description;
}

function switchProvider(provider: ExtensionSettings["activeProvider"]): void {
  activeProvider = provider;

  for (const button of providerButtons) {
    button.classList.toggle("is-active", button.dataset.providerTab === provider);
  }

  for (const pane of providerPanes) {
    pane.classList.toggle("is-active", pane.dataset.providerPane === provider);
  }

  activeProviderLabel.textContent = getCurrentProviderLabel(provider);
}

function readFormSettings(): ExtensionSettings {
  return mergeSettings(persistedSettings, {
    activeProvider,
    google: {
      apiKey: googleApiKeyInput.value.trim()
    },
    openai: {
      baseUrl: openAIBaseUrlInput.value.trim(),
      model: openAIModelInput.value.trim(),
      apiKey: openAIApiKeyInput.value.trim()
    }
  });
}

function fillForm(settings: ExtensionSettings): void {
  googleApiKeyInput.value = settings.google.apiKey;
  openAIBaseUrlInput.value = settings.openai.baseUrl;
  openAIModelInput.value = settings.openai.model;
  openAIApiKeyInput.value = settings.openai.apiKey;
  switchProvider(settings.activeProvider);
}

function normalizeBaseUrlInputValue(): void {
  const rawValue = openAIBaseUrlInput.value.trim();

  if (!rawValue) {
    return;
  }

  try {
    openAIBaseUrlInput.value = normalizeOpenAIBaseUrl(rawValue);
  } catch {
    // Keep the original input so the user can continue editing.
  }
}

async function ensurePermissions(settings: ExtensionSettings): Promise<boolean> {
  const origins = getPermissionOriginsForProvider(settings);
  const contains = await chrome.permissions.contains({ origins });

  if (contains) {
    return true;
  }

  const granted = await chrome.permissions.request({ origins });

  if (!granted) {
    throw new Error("网络访问权限没有授权成功，请重新保存并允许当前接口访问。");
  }

  return true;
}

async function verifyProvider(settings: ExtensionSettings): Promise<void> {
  const response = (await chrome.runtime.sendMessage({
    type: "TRANSLATE_SELECTION",
    payload: {
      texts: ["Hello world. LiteTrace verifies the connection."],
      settingsOverride: settings
    }
  } satisfies RuntimeMessage)) as TranslationResponse;

  if (!response.ok) {
    throw new Error(`${response.error.message}。请检查接口信息后再试。`);
  }
}

function updateValidationSummary(settings: ExtensionSettings): void {
  const errors = validateSettings(settings);
  stepProviderStatus.textContent = getCurrentProviderLabel(settings.activeProvider);

  if (errors.length > 0) {
    stepFieldsStatus.textContent = `还差 ${errors.length} 项：${errors[0]}`;
  } else {
    stepFieldsStatus.textContent = "已补齐，可以保存或验证。";
  }

  setButtonsDisabled(isSubmitting || errors.length > 0);

  stepFinishStatus.textContent = settings.preferences.hasCompletedSetup
    ? "已可用，回网页点击图标即可。"
    : "验证完成后，回网页点击图标即可。";
}

async function refreshPermissionSummary(settings: ExtensionSettings): Promise<void> {
  const checkToken = ++permissionCheckToken;
  const errors = validateSettings(settings);

  if (errors.length > 0) {
    stepConnectionStatus.textContent = "补齐字段后会请求权限。";
    return;
  }

  try {
    const contains = await chrome.permissions.contains({
      origins: getPermissionOriginsForProvider(settings)
    });

    if (checkToken !== permissionCheckToken) {
      return;
    }

    if (contains) {
      stepConnectionStatus.textContent = settings.preferences.hasCompletedSetup
        ? "权限已就绪，可直接使用。"
        : "权限已就绪，建议验证一次。";
      return;
    }

    stepConnectionStatus.textContent = "保存时会弹出权限授权。";
  } catch {
    if (checkToken !== permissionCheckToken) {
      return;
    }

    stepConnectionStatus.textContent = "暂时无法读取权限状态。";
  }
}

async function syncStepState(): Promise<void> {
  const settings = readFormSettings();
  updateValidationSummary(settings);
  await refreshPermissionSummary(settings);
}

async function persistSettings(verifyBeforeSave: boolean): Promise<void> {
  try {
    isSubmitting = true;
    setButtonsDisabled(true);
    setSuccessPanel(false);
    setFeedback(verifyBeforeSave ? "正在验证…" : "正在保存…");

    normalizeBaseUrlInputValue();

    const settings = readFormSettings();
    const errors = validateSettings(settings);

    if (errors.length > 0) {
      throw new Error(`${errors[0]} 请先补齐后再继续。`);
    }

    await ensurePermissions(settings);

    if (verifyBeforeSave) {
      await verifyProvider(settings);
      settings.preferences.hasCompletedSetup = true;
    } else {
      settings.preferences.hasCompletedSetup = persistedSettings.preferences.hasCompletedSetup;
    }

    settings.preferences.hasSeenReadingCoachmark =
      persistedSettings.preferences.hasSeenReadingCoachmark;

    await saveSettings(settings);
    persistedSettings = settings;
    fillForm(settings);

    if (verifyBeforeSave) {
      setFeedback(
        "验证通过。现在可以开始使用。",
        "success"
      );
      setSuccessPanel(
        true,
        "已经准备好",
        "回到网页后，点击图标即可开始。"
      );
    } else {
      setFeedback(
        "已保存。你也可以继续验证一次。",
        "success"
      );
      setSuccessPanel(
        true,
        "草稿已保存",
        "建议再点一次“保存并验证”。"
      );
    }

    await syncStepState();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "保存设置失败，请稍后重试。";
    setFeedback(message, "error");
  } finally {
    isSubmitting = false;
    await syncStepState();
  }
}

function handleFinish(): void {
  if (window.history.length > 1) {
    window.history.back();
    return;
  }

  window.close();
}

for (const button of providerButtons) {
  button.addEventListener("click", () => {
    const provider = button.dataset.providerTab === "openai" ? "openai" : "google";
    switchProvider(provider);
    setSuccessPanel(false);
    void syncStepState();
  });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void persistSettings(false);
});

verifyButton.addEventListener("click", () => {
  void persistSettings(true);
});

finishButton.addEventListener("click", handleFinish);

form.addEventListener("input", () => {
  setSuccessPanel(false);
  void syncStepState();
});

openAIBaseUrlInput.addEventListener("blur", () => {
  normalizeBaseUrlInputValue();
  void syncStepState();
});

void getSettings().then(async (settings) => {
  persistedSettings = settings;
  fillForm(settings);
  setFeedback("先选择接口，再补齐字段并验证一次。");
  await syncStepState();
});
