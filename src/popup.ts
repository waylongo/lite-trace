import "./popup.css";

import {
  derivePopupViewModel,
  type PopupMode,
  type PopupViewModel
} from "./popup-state";
import type { ExtensionStatus, RuntimeMessage, TranslationResponse } from "./shared/types";

const LOADING_STATUS_REFRESH_MS = 800;

const popupCard = document.getElementById("popup-card") as HTMLDivElement;
const statusChip = document.getElementById("status-chip") as HTMLDivElement;
const providerLine = document.getElementById("provider-line") as HTMLParagraphElement;
const description = document.getElementById("popup-description") as HTMLParagraphElement;
const hint = document.getElementById("popup-hint") as HTMLParagraphElement;
const feedback = document.getElementById("popup-feedback") as HTMLDivElement;
const primaryButton = document.getElementById("primary-button") as HTMLButtonElement;
const secondaryButton = document.getElementById("secondary-button") as HTMLButtonElement;

let currentMode: PopupMode = "unconfigured";
let currentViewModel: PopupViewModel | null = null;
let isRefreshingStatus = false;
let isTogglingImmersive = false;
let loadingStatusTimer: number | null = null;

function syncActionState(): void {
  const shouldBlockPrimary =
    isTogglingImmersive || (isRefreshingStatus && currentMode !== "loading");
  primaryButton.disabled =
    shouldBlockPrimary || Boolean(currentViewModel?.disablePrimary);
  secondaryButton.disabled = isRefreshingStatus || isTogglingImmersive;
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
      : mode === "loading"
        ? "正在生成双语对照"
      : mode === "active"
        ? "当前页已开启双语对照"
        : "准备好了，可以开始阅读";
}

function stopLoadingStatusPolling(): void {
  if (!loadingStatusTimer) {
    return;
  }

  window.clearInterval(loadingStatusTimer);
  loadingStatusTimer = null;
}

function syncLoadingStatusPolling(mode: PopupMode): void {
  if (mode !== "loading") {
    stopLoadingStatusPolling();
    return;
  }

  if (loadingStatusTimer) {
    return;
  }

  loadingStatusTimer = window.setInterval(() => {
    if (isRefreshingStatus || isTogglingImmersive) {
      return;
    }

    void refreshStatus();
  }, LOADING_STATUS_REFRESH_MS);
}

function renderStatus(status: ExtensionStatus): void {
  const viewModel = derivePopupViewModel(status);
  currentViewModel = viewModel;
  setStatusChip(viewModel.mode);
  syncLoadingStatusPolling(viewModel.mode);
  providerLine.textContent = viewModel.providerLine;
  description.textContent = viewModel.description;
  hint.textContent = viewModel.hint;
  primaryButton.textContent = viewModel.primaryLabel;

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
  syncActionState();
}

async function refreshStatus(): Promise<void> {
  isRefreshingStatus = true;
  syncActionState();

  try {
    const status = (await chrome.runtime.sendMessage({
      type: "GET_EXTENSION_STATUS"
    } satisfies RuntimeMessage)) as ExtensionStatus;
    renderStatus(status);
  } catch {
    setFeedback("状态读取失败，请重试。");
  } finally {
    isRefreshingStatus = false;
    syncActionState();
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
  isTogglingImmersive = true;
  syncActionState();
  setFeedback(
    previousMode === "loading"
      ? "正在停止…"
      : previousMode === "active"
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
      previousMode === "loading"
        ? "已停止。"
        : previousMode === "active"
        ? "已关闭。"
        : currentMode === "loading"
          ? "已开始生成。"
          : "已开启。"
    );
  } catch {
    setFeedback("操作失败，请重试。");
  } finally {
    isTogglingImmersive = false;
    syncActionState();
  }
}

primaryButton.addEventListener("click", () => {
  void handlePrimaryAction();
});

secondaryButton.addEventListener("click", () => {
  void openOptions();
});

window.addEventListener("pagehide", stopLoadingStatusPolling);

void refreshStatus();
