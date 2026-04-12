import "./popup.css";

import { derivePopupViewModel, type PopupMode } from "./popup-state";
import type { ExtensionStatus, RuntimeMessage, TranslationResponse } from "./shared/types";

const popupCard = document.getElementById("popup-card") as HTMLDivElement;
const statusChip = document.getElementById("status-chip") as HTMLDivElement;
const providerLine = document.getElementById("provider-line") as HTMLParagraphElement;
const description = document.getElementById("popup-description") as HTMLParagraphElement;
const hint = document.getElementById("popup-hint") as HTMLParagraphElement;
const feedback = document.getElementById("popup-feedback") as HTMLDivElement;
const primaryButton = document.getElementById("primary-button") as HTMLButtonElement;
const secondaryButton = document.getElementById("secondary-button") as HTMLButtonElement;

let currentMode: PopupMode = "unconfigured";

function setBusyState(isBusy: boolean): void {
  primaryButton.disabled = isBusy;
  secondaryButton.disabled = isBusy;
}

function setFeedback(message: string): void {
  feedback.textContent = message;
}

function setStatusChip(mode: PopupMode): void {
  currentMode = mode;
  popupCard.dataset.mode = mode;
  statusChip.textContent =
    mode === "unconfigured"
      ? "还差一步：完成配置"
      : mode === "active"
        ? "当前页已开启双语对照"
        : "准备好了，可以开始阅读";
}

function renderStatus(status: ExtensionStatus): void {
  const viewModel = derivePopupViewModel(status);
  setStatusChip(viewModel.mode);
  providerLine.textContent = viewModel.providerLine;
  description.textContent = viewModel.description;
  hint.textContent = viewModel.hint;
  primaryButton.textContent = viewModel.primaryLabel;
  primaryButton.disabled = viewModel.disablePrimary;

  if (viewModel.secondaryLabel) {
    secondaryButton.hidden = false;
    secondaryButton.textContent = viewModel.secondaryLabel;
  } else {
    secondaryButton.hidden = true;
  }

  setFeedback(
    viewModel.disablePrimary
      ? "当前标签页暂不支持开启。"
      : ""
  );
}

async function refreshStatus(): Promise<void> {
  setBusyState(true);

  try {
    const status = (await chrome.runtime.sendMessage({
      type: "GET_EXTENSION_STATUS"
    } satisfies RuntimeMessage)) as ExtensionStatus;
    renderStatus(status);
  } catch {
    setFeedback("状态读取失败，请重试。");
  } finally {
    setBusyState(false);
  }
}

async function openOptions(): Promise<void> {
  await chrome.runtime.openOptionsPage();
}

async function handlePrimaryAction(): Promise<void> {
  if (currentMode === "unconfigured") {
    await openOptions();
    return;
  }

  const previousMode = currentMode;
  setBusyState(true);
  setFeedback(
    previousMode === "active"
      ? "正在关闭…"
      : "正在开启…"
  );

  try {
    const response = (await chrome.runtime.sendMessage({
      type: "TRIGGER_ACTIVE_TAB_IMMERSIVE"
    } satisfies RuntimeMessage)) as TranslationResponse | { ok: true };

    if ("ok" in response && response.ok === false) {
      setFeedback(response.error.message);
      return;
    }

    await refreshStatus();
    setFeedback(
      previousMode === "active"
        ? "已关闭。"
        : "已开启。"
    );
  } catch {
    setFeedback("操作失败，请重试。");
  } finally {
    setBusyState(false);
  }
}

primaryButton.addEventListener("click", () => {
  void handlePrimaryAction();
});

secondaryButton.addEventListener("click", () => {
  void openOptions();
});

void refreshStatus();
