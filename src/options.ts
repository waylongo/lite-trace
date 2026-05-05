import "./options.css";

import {
  getCurrentProviderLabel,
  getPermissionOriginsForProvider,
  mergeSettings,
  normalizeOpenAIBaseUrl,
  validateSettings
} from "./shared/settings";
import { getSettings, saveSettings } from "./shared/storage";
import {
  deleteGlossaryTerm,
  getGlossaryTerms,
  toggleGlossaryTerm,
  updateGlossaryTerm,
  upsertGlossaryTerm
} from "./shared/glossary";
import type {
  ExtensionSettings,
  GlossaryTerm,
  RuntimeMessage,
  TranslationResponse
} from "./shared/types";

const providerButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-provider-tab]")
);
const providerPanes = Array.from(
  document.querySelectorAll<HTMLElement>("[data-provider-pane]")
);

const form = document.getElementById("settings-form") as HTMLFormElement;
const feedback = document.getElementById("feedback") as HTMLDivElement;
const activeProviderLabel = document.getElementById("active-provider-label") as HTMLElement;
const saveButton = document.getElementById("save-button") as HTMLButtonElement;
const verifyButton = document.getElementById("verify-button") as HTMLButtonElement;
const finishButton = document.getElementById("finish-button") as HTMLButtonElement;
const successPanel = document.getElementById("success-panel") as HTMLElement;
const successTitle = document.getElementById("success-title") as HTMLHeadingElement;
const successDescription = document.getElementById("success-description") as HTMLParagraphElement;

const fieldsStatus = document.getElementById("fields-status") as HTMLElement;
const connectionStatus = document.getElementById("connection-status") as HTMLElement;

const googleApiKeyInput = document.getElementById("google-api-key") as HTMLInputElement;
const openAIBaseUrlInput = document.getElementById("openai-base-url") as HTMLInputElement;
const openAIModelInput = document.getElementById("openai-model") as HTMLInputElement;
const openAIApiKeyInput = document.getElementById("openai-api-key") as HTMLInputElement;
const glossarySourceInput = document.getElementById(
  "glossary-source-input"
) as HTMLInputElement;
const glossaryTargetInput = document.getElementById(
  "glossary-target-input"
) as HTMLInputElement;
const glossaryAddButton = document.getElementById(
  "glossary-add-button"
) as HTMLButtonElement;
const glossarySearchInput = document.getElementById(
  "glossary-search-input"
) as HTMLInputElement;
const glossaryCount = document.getElementById("glossary-count") as HTMLElement;
const glossaryFeedback = document.getElementById("glossary-feedback") as HTMLElement;
const glossaryEmpty = document.getElementById("glossary-empty") as HTMLElement;
const glossaryList = document.getElementById("glossary-list") as HTMLElement;

let activeProvider: ExtensionSettings["activeProvider"] = "openai";
let persistedSettings = mergeSettings({});
let permissionCheckToken = 0;
let isSubmitting = false;
let glossaryTerms: GlossaryTerm[] = [];

function normalizeComparableBaseUrl(value: string): string {
  try {
    return normalizeOpenAIBaseUrl(value);
  } catch {
    return value.trim();
  }
}

function isSameActiveProviderConfig(
  left: ExtensionSettings,
  right: ExtensionSettings
): boolean {
  if (left.activeProvider !== right.activeProvider) {
    return false;
  }

  if (left.activeProvider === "google") {
    return left.google.apiKey.trim() === right.google.apiKey.trim();
  }

  return (
    normalizeComparableBaseUrl(left.openai.baseUrl) ===
      normalizeComparableBaseUrl(right.openai.baseUrl) &&
    left.openai.model.trim() === right.openai.model.trim() &&
    left.openai.apiKey.trim() === right.openai.apiKey.trim()
  );
}

function isCurrentConfigVerified(settings: ExtensionSettings): boolean {
  return (
    persistedSettings.preferences.hasCompletedSetup &&
    isSameActiveProviderConfig(settings, persistedSettings)
  );
}

function setFeedback(message: string, tone: "default" | "success" | "error" = "default"): void {
  if (!message) {
    feedback.hidden = true;
    feedback.textContent = "";
    feedback.removeAttribute("data-tone");
    return;
  }

  feedback.hidden = false;
  feedback.textContent = message;

  if (tone === "default") {
    feedback.removeAttribute("data-tone");
    return;
  }

  feedback.dataset.tone = tone;
}

function setGlossaryFeedback(
  message: string,
  tone: "default" | "success" | "error" = "default"
): void {
  glossaryFeedback.textContent = message;

  if (tone === "default" || !message) {
    glossaryFeedback.removeAttribute("data-tone");
    return;
  }

  glossaryFeedback.dataset.tone = tone;
}

function matchesGlossarySearch(term: GlossaryTerm, query: string): boolean {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.toLocaleLowerCase();
  return (
    term.sourceText.toLocaleLowerCase().includes(normalizedQuery) ||
    term.targetText.toLocaleLowerCase().includes(normalizedQuery)
  );
}

function renderGlossaryTerms(): void {
  const query = glossarySearchInput.value.trim();
  const visibleTerms = glossaryTerms.filter((term) =>
    matchesGlossarySearch(term, query)
  );

  glossaryCount.textContent = `${glossaryTerms.length} 条`;
  glossaryEmpty.hidden = glossaryTerms.length > 0;
  glossaryList.innerHTML = "";

  for (const term of visibleTerms) {
    const row = document.createElement("div");
    row.className = "glossary-term-row";
    row.dataset.termId = term.id;

    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = term.enabled;
    enabledInput.setAttribute("aria-label", `启用 ${term.sourceText}`);

    const sourceInput = document.createElement("input");
    sourceInput.type = "text";
    sourceInput.value = term.sourceText;
    sourceInput.setAttribute("aria-label", "英文术语");

    const targetInput = document.createElement("input");
    targetInput.type = "text";
    targetInput.value = term.targetText;
    targetInput.setAttribute("aria-label", "中文译法");

    const saveTermButton = document.createElement("button");
    saveTermButton.type = "button";
    saveTermButton.dataset.action = "save";
    saveTermButton.textContent = "保存";

    const deleteTermButton = document.createElement("button");
    deleteTermButton.type = "button";
    deleteTermButton.dataset.action = "delete";
    deleteTermButton.textContent = "删除";

    enabledInput.addEventListener("change", async () => {
      await toggleGlossaryTerm(term.id, enabledInput.checked);
      setGlossaryFeedback(enabledInput.checked ? "已启用术语。" : "已停用术语。", "success");
      await refreshGlossaryTerms();
    });

    saveTermButton.addEventListener("click", async () => {
      try {
        const updatedTerm = await updateGlossaryTerm(term.id, {
          sourceText: sourceInput.value,
          targetText: targetInput.value
        });

        if (!updatedTerm) {
          throw new Error("该术语已不存在，请刷新后重试。");
        }

        setGlossaryFeedback("术语已保存。", "success");
        await refreshGlossaryTerms();
      } catch (error) {
        setGlossaryFeedback(
          error instanceof Error ? error.message : "术语保存失败，请稍后重试。",
          "error"
        );
      }
    });

    [sourceInput, targetInput].forEach((input) => {
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") {
          return;
        }

        event.preventDefault();
        saveTermButton.click();
      });
    });

    deleteTermButton.addEventListener("click", async () => {
      await deleteGlossaryTerm(term.id);
      setGlossaryFeedback("术语已删除。", "success");
      await refreshGlossaryTerms();
    });

    row.append(
      enabledInput,
      sourceInput,
      targetInput,
      saveTermButton,
      deleteTermButton
    );
    glossaryList.append(row);
  }
}

async function refreshGlossaryTerms(): Promise<void> {
  glossaryTerms = await getGlossaryTerms();
  renderGlossaryTerms();
}

async function addGlossaryTermFromInputs(): Promise<void> {
  try {
    await upsertGlossaryTerm({
      sourceText: glossarySourceInput.value,
      targetText: glossaryTargetInput.value
    });
    glossarySourceInput.value = "";
    glossaryTargetInput.value = "";
    setGlossaryFeedback("术语已添加。", "success");
    await refreshGlossaryTerms();
  } catch (error) {
    setGlossaryFeedback(
      error instanceof Error ? error.message : "术语添加失败，请稍后重试。",
      "error"
    );
  }
}

function setStatusBadge(
  element: HTMLElement,
  message: string,
  state: "idle" | "warning" | "ready"
): void {
  element.textContent = message;
  element.dataset.state = state;
}

function setButtonsDisabled(disabled: boolean): void {
  saveButton.disabled = disabled;
  verifyButton.disabled = disabled;
}

function setSuccessPanel(
  visible: boolean,
  title = "已经可以开始浅译了",
  description = "回到网页后，点击右侧浅译按钮即可开始双语阅读。"
): void {
  successPanel.hidden = !visible;
  successTitle.textContent = title;
  successDescription.textContent = description;
}

function switchProvider(provider: ExtensionSettings["activeProvider"]): void {
  activeProvider = provider;

  for (const button of providerButtons) {
    const isActive = button.dataset.providerTab === provider;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
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
    const message = response.error.message;

    if (/暂时不可用（(?:502|503|504)）/.test(message)) {
      throw new Error(`${message} 当前更像是接口临时波动，建议稍后再试。`);
    }

    throw new Error(`${message}。请检查接口信息后再试。`);
  }
}

function updateValidationSummary(settings: ExtensionSettings): void {
  const errors = validateSettings(settings);
  activeProviderLabel.textContent = getCurrentProviderLabel(settings.activeProvider);

  if (errors.length > 0) {
    setStatusBadge(fieldsStatus, "待补充", "warning");
  } else {
    setStatusBadge(fieldsStatus, "已补齐", "ready");
  }

  setButtonsDisabled(isSubmitting || errors.length > 0);
}

async function refreshPermissionSummary(settings: ExtensionSettings): Promise<void> {
  const checkToken = ++permissionCheckToken;
  const errors = validateSettings(settings);

  if (errors.length > 0) {
    setStatusBadge(connectionStatus, "待填写", "idle");
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
      if (isCurrentConfigVerified(settings)) {
        setStatusBadge(connectionStatus, "已就绪", "ready");
      } else {
        setStatusBadge(connectionStatus, "待验证", "warning");
      }

      return;
    }

    setStatusBadge(connectionStatus, "待授权", "idle");
  } catch {
    if (checkToken !== permissionCheckToken) {
      return;
    }

    setStatusBadge(connectionStatus, "未确认", "warning");
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
      settings.preferences.hasCompletedSetup = isCurrentConfigVerified(settings);
    }

    settings.preferences.hasSeenReadingCoachmark =
      persistedSettings.preferences.hasSeenReadingCoachmark;

    await saveSettings(settings);
    persistedSettings = settings;
    fillForm(settings);

    if (verifyBeforeSave) {
      setFeedback(
        "验证通过。现在可以用自己的接口开始浅译了。",
        "success"
      );
      setSuccessPanel(
        true,
        "已经可以开始浅译了",
        "回到网页后，点击右侧浅译按钮即可开始双语阅读。"
      );
    } else {
      if (settings.preferences.hasCompletedSetup) {
        setFeedback("已保存，当前连接仍然可用。", "success");
        setSuccessPanel(
          true,
          "已保存，可以继续浅译",
          "回到网页后，点击右侧浅译按钮即可开始双语阅读。"
        );
      } else {
        setFeedback("已保存，建议再验证一次。", "success");
        setSuccessPanel(
          true,
          "已保存，等待验证",
          "点一次“保存并验证”后再开始使用。"
        );
      }
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
    setFeedback("");
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
  setFeedback("");
  void syncStepState();
});

openAIBaseUrlInput.addEventListener("blur", () => {
  normalizeBaseUrlInputValue();
  void syncStepState();
});

glossarySearchInput.addEventListener("input", () => {
  renderGlossaryTerms();
});

glossaryAddButton.addEventListener("click", () => {
  void addGlossaryTermFromInputs();
});

[glossarySourceInput, glossaryTargetInput].forEach((input) => {
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    void addGlossaryTermFromInputs();
  });
});

void getSettings().then(async (settings) => {
  persistedSettings = settings;
  fillForm(settings);
  setFeedback("");
  await refreshGlossaryTerms();
  await syncStepState();
});
