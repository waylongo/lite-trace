import {
  collectTranslatableBlocks,
  groupTranslatableBlocks,
  isEditableNode,
  isTranslatableSelectionText,
  normalizeText,
  prioritizeTranslatableBlocks
} from "./shared/content-helpers";
import { chunkTextLikeItems } from "./shared/batching";
import {
  applyImmersiveTranslations,
  clearImmersiveTranslations,
  hasImmersiveTranslations,
  SOURCE_SELECTOR
} from "./shared/immersive";
import type {
  GlossaryTerm,
  GroupedTranslatableBlocks,
  ImmersiveProgress,
  RuntimeMessage,
  TranslatableBlock,
  TranslationResponse
} from "./shared/types";

const STYLE_ID = "litetrace-inline-style";
const BUBBLE_ID = "litetrace-selection-bubble";
const IMMERSIVE_BUBBLE_ID = "litetrace-immersive-bubble";
const IMMERSIVE_BUBBLE_POSITION_KEY = "litetrace.immersiveBubble.yRatio";
const GLOSSARY_STORAGE_KEY = "litetrace.glossary.terms";
const GLOSSARY_MAX_TERMS = 500;
const POPUP_ID = "litetrace-selection-popup";
const GLOSSARY_EDITOR_ID = "litetrace-glossary-editor";
const TOAST_ID = "litetrace-toast";
const CONTENT_RUNTIME_FLAG = "__litetraceInitialized";
const SELECTION_BUBBLE_SIZE = 42;
const FIRST_IMMERSIVE_BATCH_MAX_ITEMS = 3;
const FIRST_IMMERSIVE_BATCH_MAX_CHARS = 1_800;
const STEADY_IMMERSIVE_BATCH_MAX_ITEMS = 8;
const STEADY_IMMERSIVE_BATCH_MAX_CHARS = 4_200;
const STEADY_IMMERSIVE_BATCH_CONCURRENCY = 3;
const IMMERSIVE_BUBBLE_DEFAULT_BOTTOM = 86;
const IMMERSIVE_BUBBLE_EDGE_GAP = 12;
const IMMERSIVE_BUBBLE_HEIGHT = 44;
const IMMERSIVE_BUBBLE_DRAG_THRESHOLD = 5;
const PAGE_URL_CHECK_INTERVAL_MS = 1_000;
const TRANSLATE_ICON_HTML = `
  <svg data-icon="translate" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M2.8 5.2h11.4" />
    <path d="M7.4 2.8v2.4" />
    <path d="m5 8.2 6.1 6.1" />
    <path d="m4.2 14.2 6.1-6.1 2-3" />
    <path d="m21.2 21.2-4.7-9.7-4.7 9.7" />
    <path d="M13.5 17.5h6" />
  </svg>
`;
const IMMERSIVE_BUBBLE_ICON_HTML = {
  idle: TRANSLATE_ICON_HTML,
  loading: `
    <svg data-icon="stop" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="7" y="7" width="10" height="10" rx="2.2" />
    </svg>
  `,
  active: `
    <svg data-icon="check" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 6.5 9.2 17.3 4 12.1" />
    </svg>
  `
} as const;

let lastPointer = { x: 0, y: 0 };
let bubbleEl: HTMLButtonElement | null = null;
let immersiveBubbleEl: HTMLButtonElement | null = null;
let immersiveBubbleYRatio: number | null = null;
let immersiveBubbleDrag:
  | {
      pointerId: number;
      startClientY: number;
      startTop: number;
      didDrag: boolean;
    }
  | null = null;
let suppressImmersiveBubbleClick = false;
let popupEl: HTMLDivElement | null = null;
let glossaryEditorEl: HTMLDivElement | null = null;
let toastEl: HTMLDivElement | null = null;
let selectionTimer: number | null = null;
let requestSequence = 0;
let uiInteraction = false;
let toastTimer: number | null = null;
let immersiveJobId = 0;
let immersiveLoading = false;
let immersiveProgress: ImmersiveProgress | null = null;
let pendingGlossaryRetouchTerms: GlossaryTerm[] = [];
let activeSelection: SelectionSnapshot | null = null;
let currentPageUrl = window.location.href;

interface ImmersiveFailureState {
  message: string;
  action?: "open-options";
}

interface SelectionSnapshot {
  text: string;
  rect: DOMRect | null;
  key: string;
  fallbackPlacement?: "pointer" | "viewport-top-right";
}

type ImmersiveBubbleIconKind = keyof typeof IMMERSIVE_BUBBLE_ICON_HTML;

type LiteTraceWindow = Window & {
  [CONTENT_RUNTIME_FLAG]?: boolean;
};

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .litetrace-immersive-translation {
      color: inherit;
      margin-block-start: 0 !important;
    }

    [data-litetrace-source] {
      margin-block-end: 0.14em !important;
    }

    [data-litetrace-source]:is(h1, h2, h3, h4, h5, h6) {
      margin-block-end: 0.06em !important;
    }

    .litetrace-immersive-translation:is(h1, h2, h3, h4, h5, h6) {
      margin-block-start: 0 !important;
    }

    #${BUBBLE_ID} {
      position: fixed;
      z-index: 2147483647;
      width: 42px;
      min-width: 42px;
      height: 42px;
      padding: 0;
      border: 0;
      border-radius: 999px;
      background: linear-gradient(135deg, #0a6f51, #2767a7);
      color: white;
      box-shadow: 0 14px 32px rgba(9, 49, 37, 0.22);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      overflow: hidden;
      -webkit-tap-highlight-color: transparent;
    }

    #${BUBBLE_ID} svg {
      width: 22px;
      height: 22px;
      display: block;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      pointer-events: none;
    }

    #${BUBBLE_ID}[hidden] {
      display: none;
    }

    #${IMMERSIVE_BUBBLE_ID} {
      position: fixed;
      right: 18px;
      bottom: 86px;
      z-index: 2147483647;
      width: 44px;
      min-width: 44px;
      height: 44px;
      padding: 0;
      border: 0;
      border-radius: 999px;
      background: rgba(252, 255, 252, 0.98);
      color: #0f513d;
      box-shadow: 0 14px 32px rgba(9, 49, 37, 0.22);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
      cursor: pointer;
      overflow: hidden;
      touch-action: none;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }

    #${IMMERSIVE_BUBBLE_ID} .litetrace-immersive-ring,
    #${IMMERSIVE_BUBBLE_ID} .litetrace-immersive-icon {
      pointer-events: none;
    }

    #${IMMERSIVE_BUBBLE_ID} .litetrace-immersive-ring {
      position: absolute;
      inset: 3px;
      border-radius: inherit;
      opacity: 0;
      background: conic-gradient(
        currentColor var(--litetrace-progress, 0deg),
        rgba(255, 255, 255, 0.22) 0deg
      );
      -webkit-mask: radial-gradient(
        farthest-side,
        transparent calc(100% - 4px),
        #000 calc(100% - 3px)
      );
      mask: radial-gradient(
        farthest-side,
        transparent calc(100% - 4px),
        #000 calc(100% - 3px)
      );
    }

    #${IMMERSIVE_BUBBLE_ID} .litetrace-immersive-icon {
      position: relative;
      z-index: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
    }

    #${IMMERSIVE_BUBBLE_ID} .litetrace-immersive-icon svg {
      width: 22px;
      height: 22px;
      display: block;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    #${IMMERSIVE_BUBBLE_ID}[data-state="loading"] {
      color: #f8fff9;
      background: linear-gradient(135deg, #1f5f99, #0a6f51);
    }

    #${IMMERSIVE_BUBBLE_ID}[data-state="loading"] .litetrace-immersive-ring {
      opacity: 1;
    }

    #${IMMERSIVE_BUBBLE_ID}[data-state="loading"][data-progress="indeterminate"] .litetrace-immersive-ring {
      background: conic-gradient(
        from 0deg,
        transparent 0deg,
        rgba(248, 255, 249, 0.18) 110deg,
        currentColor 300deg,
        transparent 360deg
      );
      animation: litetrace-immersive-spin 0.9s linear infinite;
    }

    #${IMMERSIVE_BUBBLE_ID}[data-state="loading"][data-progress="determinate"] .litetrace-immersive-ring {
      animation: none;
    }

    #${IMMERSIVE_BUBBLE_ID}[data-state="active"] {
      color: #f8fff9;
      background: #203127;
    }

    #${IMMERSIVE_BUBBLE_ID}:disabled {
      cursor: wait;
      opacity: 0.72;
    }

    @keyframes litetrace-immersive-spin {
      to {
        transform: rotate(360deg);
      }
    }

    #${POPUP_ID} {
      position: fixed;
      z-index: 2147483647;
      width: min(360px, calc(100vw - 24px));
      border-radius: 18px;
      border: 1px solid rgba(7, 58, 45, 0.16);
      background: rgba(252, 255, 252, 0.98);
      box-shadow: 0 18px 48px rgba(9, 49, 37, 0.2);
      backdrop-filter: blur(12px);
      color: #18352a;
      overflow: hidden;
      font-family: "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
    }

    #${POPUP_ID}[hidden] {
      display: none;
    }

    .litetrace-popup-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px 10px;
      background: linear-gradient(135deg, #eff8f3, #edf4ff);
      border-bottom: 1px solid rgba(7, 58, 45, 0.08);
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #406051;
    }

    .litetrace-popup-title {
      font-weight: 700;
    }

    .litetrace-popup-close,
    .litetrace-popup-action,
    .litetrace-popup-copy {
      border: 0;
      cursor: pointer;
      font: inherit;
    }

    .litetrace-popup-close {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      background: rgba(7, 58, 45, 0.08);
      color: #26463b;
    }

    .litetrace-popup-body {
      padding: 14px;
      font-size: 14px;
      line-height: 1.75;
      white-space: pre-wrap;
    }

    .litetrace-popup-meta {
      padding: 0 14px 14px;
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }

    .litetrace-popup-copy,
    .litetrace-popup-action {
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
    }

    .litetrace-popup-copy {
      color: #1b4d3f;
      background: rgba(14, 108, 79, 0.1);
    }

    .litetrace-popup-action {
      color: white;
      background: linear-gradient(135deg, #0a6f51, #2767a7);
    }

    #${GLOSSARY_EDITOR_ID} {
      position: fixed;
      z-index: 2147483647;
      width: min(360px, calc(100vw - 24px));
      border-radius: 18px;
      border: 1px solid rgba(7, 58, 45, 0.16);
      background: rgba(252, 255, 252, 0.98);
      color: #18352a;
      box-shadow: 0 18px 48px rgba(9, 49, 37, 0.2);
      backdrop-filter: blur(12px);
      font-family: "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
      overflow: hidden;
    }

    #${GLOSSARY_EDITOR_ID}[hidden] {
      display: none;
    }

    .litetrace-glossary-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px 10px;
      border-bottom: 1px solid rgba(7, 58, 45, 0.08);
      background: linear-gradient(135deg, #eff8f3, #edf4ff);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #406051;
    }

    .litetrace-glossary-close {
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 999px;
      background: rgba(7, 58, 45, 0.08);
      color: #26463b;
      cursor: pointer;
      font: inherit;
    }

    .litetrace-glossary-form {
      display: grid;
      gap: 10px;
      padding: 14px;
    }

    .litetrace-glossary-field {
      display: grid;
      gap: 6px;
      font-size: 12px;
      font-weight: 700;
      color: #406051;
    }

    .litetrace-glossary-field input {
      min-height: 38px;
      border: 1px solid rgba(7, 58, 45, 0.16);
      border-radius: 12px;
      padding: 8px 10px;
      color: #18352a;
      background: white;
      font: inherit;
      font-size: 14px;
      font-weight: 500;
      outline: none;
    }

    .litetrace-glossary-field input:focus {
      border-color: rgba(10, 111, 81, 0.5);
      box-shadow: 0 0 0 3px rgba(10, 111, 81, 0.12);
    }

    .litetrace-glossary-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 2px;
    }

    .litetrace-glossary-feedback {
      flex: 1;
      min-height: 18px;
      color: #587066;
      font-size: 12px;
      line-height: 1.5;
    }

    .litetrace-glossary-save {
      border: 0;
      border-radius: 999px;
      padding: 9px 14px;
      background: linear-gradient(135deg, #0a6f51, #2767a7);
      color: white;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 800;
    }

    .litetrace-glossary-save:disabled {
      cursor: wait;
      opacity: 0.7;
    }

    #${TOAST_ID} {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483647;
      min-width: 220px;
      max-width: min(420px, calc(100vw - 24px));
      padding: 14px 16px;
      border-radius: 16px;
      background: rgba(18, 32, 26, 0.94);
      color: #f8fff9;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.2);
      font-family: "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.6;
      white-space: pre-line;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    #${TOAST_ID}[hidden] {
      display: none;
    }

    .litetrace-toast-action {
      margin-left: auto;
      border: 0;
      background: rgba(255, 255, 255, 0.12);
      color: inherit;
      border-radius: 999px;
      padding: 7px 11px;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 700;
    }
  `;

  document.documentElement.append(style);
}

function markUiInteraction(): void {
  uiInteraction = true;
  window.setTimeout(() => {
    uiInteraction = false;
  }, 0);
}

function normalizeGlossarySource(text: string): string {
  return normalizeText(text).toLocaleLowerCase();
}

function isAsciiWordCharacter(character: string): boolean {
  return /^[A-Za-z0-9_]$/.test(character);
}

function doesGlossaryTermMatchText(sourceText: string, text: string): boolean {
  const needle = normalizeGlossarySource(sourceText);
  const haystack = normalizeGlossarySource(text);

  if (!needle || !haystack) {
    return false;
  }

  let searchFrom = 0;

  while (searchFrom < haystack.length) {
    const index = haystack.indexOf(needle, searchFrom);

    if (index < 0) {
      return false;
    }

    const before = index > 0 ? haystack[index - 1] : "";
    const afterIndex = index + needle.length;
    const after = afterIndex < haystack.length ? haystack[afterIndex] : "";
    const startsWithWord = isAsciiWordCharacter(needle[0] ?? "");
    const endsWithWord = isAsciiWordCharacter(needle[needle.length - 1] ?? "");
    const hasLeftBoundary = !startsWithWord || !before || !isAsciiWordCharacter(before);
    const hasRightBoundary = !endsWithWord || !after || !isAsciiWordCharacter(after);

    if (hasLeftBoundary && hasRightBoundary) {
      return true;
    }

    searchFrom = index + needle.length;
  }

  return false;
}

function createGlossaryTermId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `term-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function isGlossaryTerm(value: unknown): value is GlossaryTerm {
  if (!value || typeof value !== "object") {
    return false;
  }

  const term = value as Partial<GlossaryTerm>;
  return (
    typeof term.id === "string" &&
    typeof term.sourceText === "string" &&
    typeof term.targetText === "string" &&
    typeof term.enabled === "boolean" &&
    typeof term.createdAt === "number" &&
    typeof term.updatedAt === "number"
  );
}

function sanitizeContentGlossaryTerms(value: unknown): GlossaryTerm[] {
  const rawTerms =
    value &&
    typeof value === "object" &&
    Array.isArray((value as { terms?: unknown }).terms)
      ? (value as { terms: unknown[] }).terms
      : [];
  const terms: GlossaryTerm[] = [];
  const seenSources = new Set<string>();

  for (const rawTerm of rawTerms) {
    if (!isGlossaryTerm(rawTerm)) {
      continue;
    }

    const sourceText = normalizeText(rawTerm.sourceText);
    const targetText = normalizeText(rawTerm.targetText);
    const sourceKey = normalizeGlossarySource(sourceText);

    if (!sourceText || !targetText || !/[A-Za-z]/.test(sourceText) || seenSources.has(sourceKey)) {
      continue;
    }

    seenSources.add(sourceKey);
    terms.push({
      ...rawTerm,
      sourceText,
      targetText
    });

    if (terms.length >= GLOSSARY_MAX_TERMS) {
      break;
    }
  }

  return terms;
}

async function getContentGlossaryTerms(): Promise<GlossaryTerm[]> {
  const stored = await chrome.storage.local.get(GLOSSARY_STORAGE_KEY);
  return sanitizeContentGlossaryTerms(stored[GLOSSARY_STORAGE_KEY]);
}

async function writeContentGlossaryTerms(terms: GlossaryTerm[]): Promise<void> {
  await chrome.storage.local.set({
    [GLOSSARY_STORAGE_KEY]: {
      version: 1,
      terms: sanitizeContentGlossaryTerms({ terms })
    }
  });
}

async function upsertContentGlossaryTerm(input: {
  sourceText: string;
  targetText: string;
}): Promise<GlossaryTerm> {
  const sourceText = normalizeText(input.sourceText);
  const targetText = normalizeText(input.targetText);

  if (!sourceText || !/[A-Za-z]/.test(sourceText)) {
    throw new Error("英文术语不能为空，且需要包含英文字母。");
  }

  if (!targetText) {
    throw new Error("中文译法不能为空。");
  }

  const terms = await getContentGlossaryTerms();
  const sourceKey = normalizeGlossarySource(sourceText);
  const existingIndex = terms.findIndex(
    (term) => normalizeGlossarySource(term.sourceText) === sourceKey
  );
  const now = Date.now();
  let term: GlossaryTerm;
  let nextTerms: GlossaryTerm[];

  if (existingIndex >= 0) {
    term = {
      ...terms[existingIndex],
      sourceText,
      targetText,
      enabled: true,
      updatedAt: now
    };
    nextTerms = [...terms];
    nextTerms[existingIndex] = term;
  } else {
    if (terms.length >= GLOSSARY_MAX_TERMS) {
      throw new Error(`术语库最多保存 ${GLOSSARY_MAX_TERMS} 条，请先删除旧词条。`);
    }

    term = {
      id: createGlossaryTermId(),
      sourceText,
      targetText,
      enabled: true,
      createdAt: now,
      updatedAt: now
    };
    nextTerms = [term, ...terms];
  }

  await writeContentGlossaryTerms(nextTerms);
  return term;
}

function getBubble(): HTMLButtonElement {
  if (bubbleEl) {
    return bubbleEl;
  }

  const existing = document.getElementById(BUBBLE_ID) as HTMLButtonElement | null;

  if (existing) {
    bubbleEl = existing;
    return bubbleEl;
  }

  bubbleEl = document.createElement("button");
  bubbleEl.id = BUBBLE_ID;
  bubbleEl.type = "button";
  bubbleEl.hidden = true;
  bubbleEl.innerHTML = TRANSLATE_ICON_HTML;
  bubbleEl.setAttribute("aria-label", "翻译所选内容");
  bubbleEl.title = "翻译所选内容";

  bubbleEl.addEventListener("mousedown", (event) => {
    event.preventDefault();
    markUiInteraction();
  });

  bubbleEl.addEventListener("click", () => {
    if (!activeSelection) {
      return;
    }

    void translateSelectionSnapshot(activeSelection);
  });

  document.documentElement.append(bubbleEl);
  return bubbleEl;
}

function ensureImmersiveBubbleContents(bubble: HTMLButtonElement): void {
  if (
    bubble.querySelector(".litetrace-immersive-ring") &&
    bubble.querySelector(".litetrace-immersive-icon")
  ) {
    return;
  }

  bubble.textContent = "";
  bubble.innerHTML = `
    <span class="litetrace-immersive-ring" aria-hidden="true"></span>
    <span class="litetrace-immersive-icon" aria-hidden="true"></span>
  `;
}

function setImmersiveBubbleIcon(
  bubble: HTMLButtonElement,
  iconKind: ImmersiveBubbleIconKind
): void {
  ensureImmersiveBubbleContents(bubble);

  if (bubble.dataset.icon === iconKind) {
    return;
  }

  const icon = bubble.querySelector<HTMLElement>(".litetrace-immersive-icon");
  if (!icon) {
    return;
  }

  icon.innerHTML = IMMERSIVE_BUBBLE_ICON_HTML[iconKind];
  bubble.dataset.icon = iconKind;
}

function syncImmersiveBubbleProgress(bubble: HTMLButtonElement): void {
  if (!immersiveLoading) {
    bubble.style.removeProperty("--litetrace-progress");
    delete bubble.dataset.progress;
    return;
  }

  const progress = immersiveProgress;

  if (!progress?.totalCount) {
    bubble.style.removeProperty("--litetrace-progress");
    bubble.dataset.progress = "indeterminate";
    bubble.title = "停止生成双语阅读";
    return;
  }

  const progressRatio = Math.max(
    0,
    Math.min(1, progress.completedCount / progress.totalCount)
  );
  const progressDegrees = Math.round(progressRatio * 360);

  bubble.style.setProperty("--litetrace-progress", `${progressDegrees}deg`);
  bubble.dataset.progress = "determinate";
  bubble.title = `停止生成双语阅读（已完成 ${progress.completedCount}/${progress.totalCount}，已插入 ${progress.insertedCount} 段）`;
}

function syncImmersiveBubbleState(): void {
  const bubble = immersiveBubbleEl ?? getImmersiveBubble();
  ensureImmersiveBubbleContents(bubble);

  if (immersiveLoading) {
    setImmersiveBubbleIcon(bubble, "loading");
    bubble.dataset.state = "loading";
    bubble.setAttribute("aria-label", "停止生成双语阅读");
    syncImmersiveBubbleProgress(bubble);
    return;
  }

  syncImmersiveBubbleProgress(bubble);

  if (hasImmersiveTranslations(document)) {
    setImmersiveBubbleIcon(bubble, "active");
    bubble.dataset.state = "active";
    bubble.setAttribute("aria-label", "关闭双语对照");
    bubble.title = "关闭双语对照";
    return;
  }

  setImmersiveBubbleIcon(bubble, "idle");
  bubble.dataset.state = "idle";
  bubble.setAttribute("aria-label", "开启双语阅读");
  bubble.title = "开启双语阅读";
}

function getImmersiveBubbleHeight(bubble: HTMLElement): number {
  const rect = bubble.getBoundingClientRect();
  return rect.height > 0 ? rect.height : IMMERSIVE_BUBBLE_HEIGHT;
}

function getDefaultImmersiveBubbleTop(bubble: HTMLElement): number {
  return (
    window.innerHeight -
    IMMERSIVE_BUBBLE_DEFAULT_BOTTOM -
    getImmersiveBubbleHeight(bubble)
  );
}

function clampImmersiveBubbleTop(top: number, bubble: HTMLElement): number {
  const height = getImmersiveBubbleHeight(bubble);
  const maxTop = Math.max(
    IMMERSIVE_BUBBLE_EDGE_GAP,
    window.innerHeight - height - IMMERSIVE_BUBBLE_EDGE_GAP
  );

  return Math.max(IMMERSIVE_BUBBLE_EDGE_GAP, Math.min(top, maxTop));
}

function getImmersiveBubbleYRatio(top: number, bubble: HTMLElement): number {
  const height = getImmersiveBubbleHeight(bubble);
  const availableHeight = Math.max(1, window.innerHeight - height);
  return Math.max(0, Math.min(1, top / availableHeight));
}

function applyImmersiveBubbleYRatio(yRatio: number): void {
  const bubble = immersiveBubbleEl;

  if (!bubble) {
    return;
  }

  const height = getImmersiveBubbleHeight(bubble);
  const top = clampImmersiveBubbleTop(
    yRatio * Math.max(1, window.innerHeight - height),
    bubble
  );

  bubble.style.top = `${top}px`;
  bubble.style.bottom = "auto";
}

function setImmersiveBubbleTop(top: number): void {
  const bubble = immersiveBubbleEl;

  if (!bubble) {
    return;
  }

  const clampedTop = clampImmersiveBubbleTop(top, bubble);
  immersiveBubbleYRatio = getImmersiveBubbleYRatio(clampedTop, bubble);
  bubble.style.top = `${clampedTop}px`;
  bubble.style.bottom = "auto";
}

async function saveImmersiveBubblePosition(): Promise<void> {
  if (immersiveBubbleYRatio === null) {
    return;
  }

  await chrome.storage.local.set({
    [IMMERSIVE_BUBBLE_POSITION_KEY]: immersiveBubbleYRatio
  });
}

async function restoreImmersiveBubblePosition(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(IMMERSIVE_BUBBLE_POSITION_KEY);
    const yRatio = stored[IMMERSIVE_BUBBLE_POSITION_KEY];

    if (typeof yRatio === "number" && Number.isFinite(yRatio)) {
      immersiveBubbleYRatio = Math.max(0, Math.min(1, yRatio));
      applyImmersiveBubbleYRatio(immersiveBubbleYRatio);
      return;
    }
  } catch {
    // Keep the default position if stored placement cannot be read.
  }

  const bubble = immersiveBubbleEl;
  if (!bubble) {
    return;
  }

  setImmersiveBubbleTop(getDefaultImmersiveBubbleTop(bubble));
}

function handleImmersiveBubblePointerDown(event: PointerEvent): void {
  const bubble = getImmersiveBubble();
  const currentTop =
    bubble.style.top
      ? Number.parseFloat(bubble.style.top)
      : getDefaultImmersiveBubbleTop(bubble);

  immersiveBubbleDrag = {
    pointerId: event.pointerId,
    startClientY: event.clientY,
    startTop: clampImmersiveBubbleTop(currentTop, bubble),
    didDrag: false
  };
  markUiInteraction();
  event.preventDefault();
  bubble.setPointerCapture?.(event.pointerId);
}

function handleImmersiveBubblePointerMove(event: PointerEvent): void {
  if (!immersiveBubbleDrag || event.pointerId !== immersiveBubbleDrag.pointerId) {
    return;
  }

  const deltaY = event.clientY - immersiveBubbleDrag.startClientY;

  if (Math.abs(deltaY) >= IMMERSIVE_BUBBLE_DRAG_THRESHOLD) {
    immersiveBubbleDrag.didDrag = true;
  }

  if (immersiveBubbleDrag.didDrag) {
    setImmersiveBubbleTop(immersiveBubbleDrag.startTop + deltaY);
    event.preventDefault();
  }
}

function handleImmersiveBubblePointerUp(event: PointerEvent): void {
  if (!immersiveBubbleDrag || event.pointerId !== immersiveBubbleDrag.pointerId) {
    return;
  }

  const didDrag = immersiveBubbleDrag.didDrag;
  immersiveBubbleDrag = null;
  getImmersiveBubble().releasePointerCapture?.(event.pointerId);

  if (didDrag) {
    suppressImmersiveBubbleClick = true;
    void saveImmersiveBubblePosition();
    event.preventDefault();
  }
}

function getImmersiveBubble(): HTMLButtonElement {
  if (immersiveBubbleEl) {
    return immersiveBubbleEl;
  }

  const existing = document.getElementById(
    IMMERSIVE_BUBBLE_ID
  ) as HTMLButtonElement | null;

  if (existing) {
    immersiveBubbleEl = existing;
    syncImmersiveBubbleState();
    void restoreImmersiveBubblePosition();
    return immersiveBubbleEl;
  }

  immersiveBubbleEl = document.createElement("button");
  immersiveBubbleEl.id = IMMERSIVE_BUBBLE_ID;
  immersiveBubbleEl.type = "button";
  immersiveBubbleEl.setAttribute("aria-label", "开启双语阅读");

  immersiveBubbleEl.addEventListener("pointerdown", handleImmersiveBubblePointerDown);
  immersiveBubbleEl.addEventListener("pointermove", handleImmersiveBubblePointerMove);
  immersiveBubbleEl.addEventListener("pointerup", handleImmersiveBubblePointerUp);
  immersiveBubbleEl.addEventListener("pointercancel", handleImmersiveBubblePointerUp);

  immersiveBubbleEl.addEventListener("click", (event) => {
    if (suppressImmersiveBubbleClick) {
      suppressImmersiveBubbleClick = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    try {
      toggleImmersiveTranslation();
      syncImmersiveBubbleState();
    } catch {
      showToast("当前页面的双语阅读切换失败了，请稍后重试。");
    }
  });

  document.documentElement.append(immersiveBubbleEl);
  syncImmersiveBubbleState();
  void restoreImmersiveBubblePosition();
  return immersiveBubbleEl;
}

function getPopup(): HTMLDivElement {
  if (popupEl) {
    return popupEl;
  }

  const existing = document.getElementById(POPUP_ID) as HTMLDivElement | null;

  if (existing) {
    popupEl = existing;
    return popupEl;
  }

  popupEl = document.createElement("div");
  popupEl.id = POPUP_ID;
  popupEl.hidden = true;
  popupEl.innerHTML = `
    <div class="litetrace-popup-header">
      <span class="litetrace-popup-title">浅译划词翻译</span>
      <button class="litetrace-popup-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="litetrace-popup-body"></div>
    <div class="litetrace-popup-meta"></div>
  `;

  popupEl.addEventListener("mousedown", () => {
    markUiInteraction();
  });

  popupEl
    .querySelector<HTMLButtonElement>(".litetrace-popup-close")
    ?.addEventListener("click", () => {
      hidePopup();
    });

  document.documentElement.append(popupEl);
  return popupEl;
}

function getGlossaryEditor(): HTMLDivElement {
  if (glossaryEditorEl) {
    return glossaryEditorEl;
  }

  const existing = document.getElementById(GLOSSARY_EDITOR_ID) as HTMLDivElement | null;

  if (existing) {
    glossaryEditorEl = existing;
    return glossaryEditorEl;
  }

  glossaryEditorEl = document.createElement("div");
  glossaryEditorEl.id = GLOSSARY_EDITOR_ID;
  glossaryEditorEl.hidden = true;
  glossaryEditorEl.innerHTML = `
    <div class="litetrace-glossary-head">
      <span>加入浅译术语</span>
      <button class="litetrace-glossary-close" type="button" aria-label="关闭">×</button>
    </div>
    <form class="litetrace-glossary-form">
      <label class="litetrace-glossary-field">
        <span>英文术语</span>
        <input name="source" type="text" autocomplete="off" />
      </label>
      <label class="litetrace-glossary-field">
        <span>中文译法</span>
        <input name="target" type="text" autocomplete="off" />
      </label>
      <div class="litetrace-glossary-actions">
        <span class="litetrace-glossary-feedback" aria-live="polite"></span>
        <button class="litetrace-glossary-save" type="submit">保存术语</button>
      </div>
    </form>
  `;

  glossaryEditorEl.addEventListener("mousedown", () => {
    markUiInteraction();
  });

  glossaryEditorEl
    .querySelector<HTMLButtonElement>(".litetrace-glossary-close")
    ?.addEventListener("click", () => {
      hideGlossaryEditor();
    });

  glossaryEditorEl
    .querySelector<HTMLFormElement>(".litetrace-glossary-form")
    ?.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveGlossaryTermFromEditor();
    });

  document.documentElement.append(glossaryEditorEl);
  return glossaryEditorEl;
}

function getToast(): HTMLDivElement {
  if (toastEl) {
    return toastEl;
  }

  let toast = document.getElementById(TOAST_ID) as HTMLDivElement | null;

  if (toast) {
    toastEl = toast;
    return toastEl;
  }

  toast = document.createElement("div");
  toast.id = TOAST_ID;
  toast.hidden = true;
  document.documentElement.append(toast);
  toastEl = toast;
  return toastEl;
}

async function openOptionsPage(): Promise<void> {
  await chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
}

function showToast(
  message: string,
  actionLabel?: string,
  action?: () => void,
  durationMs = 3600
): void {
  const toast = getToast();
  toast.innerHTML = "";

  const text = document.createElement("div");
  text.textContent = message;
  toast.append(text);

  if (actionLabel && action) {
    const button = document.createElement("button");
    button.className = "litetrace-toast-action";
    button.type = "button";
    button.textContent = actionLabel;
    button.addEventListener("click", action);
    toast.append(button);
  }

  toast.hidden = false;

  if (toastTimer) {
    window.clearTimeout(toastTimer);
    toastTimer = null;
  }

  if (durationMs > 0) {
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
      toastTimer = null;
    }, durationMs);
  }
}

function hideToast(): void {
  const toast = getToast();
  toast.hidden = true;

  if (toastTimer) {
    window.clearTimeout(toastTimer);
    toastTimer = null;
  }
}

function hidePopup(): void {
  if (popupEl) {
    popupEl.hidden = true;
  }
}

function hideGlossaryEditor(): void {
  if (glossaryEditorEl) {
    glossaryEditorEl.hidden = true;
  }
}

function hideBubble(): void {
  if (bubbleEl) {
    bubbleEl.hidden = true;
  }
}

function positionPopup(
  target: HTMLElement,
  rect: DOMRect | null,
  fallbackPlacement: "pointer" | "viewport-top-right" = "pointer"
): void {
  const width = Math.min(360, window.innerWidth - 24);
  const fallbackLeft =
    fallbackPlacement === "viewport-top-right"
      ? window.innerWidth - width - 12
      : Math.max(
          12,
          Math.min(lastPointer.x - width / 2, window.innerWidth - width - 12)
        );
  const left = rect
    ? Math.max(
        12,
        Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12)
      )
    : fallbackLeft;

  const preferredTop =
    rect
      ? rect.bottom + 12
      : fallbackPlacement === "viewport-top-right"
        ? 12
        : lastPointer.y + 12;
  const top = Math.min(preferredTop, window.innerHeight - 24);

  target.style.left = `${left}px`;
  target.style.top = `${Math.max(12, top)}px`;
}

function positionBubble(target: HTMLButtonElement, rect: DOMRect | null): void {
  const width = SELECTION_BUBBLE_SIZE;
  const height = SELECTION_BUBBLE_SIZE;
  const left = rect
    ? Math.max(
        12,
        Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 12)
      )
    : Math.max(12, Math.min(lastPointer.x - width / 2, window.innerWidth - width - 12));
  const top = rect
    ? Math.max(12, rect.top - height - 10)
    : Math.max(12, lastPointer.y - height - 10);

  target.style.left = `${left}px`;
  target.style.top = `${top}px`;
}

function renderPopup(
  body: string,
  options?: {
    actionLabel?: string;
    action?: () => void;
    showCopy?: boolean;
    rect?: DOMRect | null;
    fallbackPlacement?: "pointer" | "viewport-top-right";
  }
): void {
  const popup = getPopup();
  const bodyEl = popup.querySelector(".litetrace-popup-body");
  const metaEl = popup.querySelector(".litetrace-popup-meta");

  if (!bodyEl || !metaEl) {
    return;
  }

  bodyEl.textContent = body;
  metaEl.innerHTML = "";

  if (options?.showCopy) {
    const copyButton = document.createElement("button");
    copyButton.className = "litetrace-popup-copy";
    copyButton.type = "button";
    copyButton.textContent = "复制译文";
    copyButton.addEventListener("click", async () => {
      await navigator.clipboard.writeText(body);
      showToast("译文已复制到剪贴板。");
    });
    metaEl.append(copyButton);
  }

  if (options?.actionLabel && options.action) {
    const actionButton = document.createElement("button");
    actionButton.className = "litetrace-popup-action";
    actionButton.type = "button";
    actionButton.textContent = options.actionLabel;
    actionButton.addEventListener("click", options.action);
    metaEl.append(actionButton);
  }

  positionPopup(popup, options?.rect ?? null, options?.fallbackPlacement);
  popup.hidden = false;
}

function renderBubble(snapshot: SelectionSnapshot): void {
  const bubble = getBubble();
  positionBubble(bubble, snapshot.rect);
  bubble.hidden = false;
}

function renderGlossaryEditor(snapshot: SelectionSnapshot): void {
  const editor = getGlossaryEditor();
  const sourceInput = editor.querySelector<HTMLInputElement>("input[name='source']");
  const targetInput = editor.querySelector<HTMLInputElement>("input[name='target']");
  const feedback = editor.querySelector<HTMLElement>(".litetrace-glossary-feedback");
  const saveButton = editor.querySelector<HTMLButtonElement>(".litetrace-glossary-save");

  if (!sourceInput || !targetInput || !feedback || !saveButton) {
    return;
  }

  hideBubble();
  hidePopup();
  activeSelection = snapshot;
  sourceInput.value = snapshot.text;
  targetInput.value = "";
  feedback.textContent = "";
  saveButton.disabled = false;
  positionPopup(editor, snapshot.rect, snapshot.fallbackPlacement);
  editor.hidden = false;
  targetInput.focus();
}

function clearSelectionUi(options: { hideGlossaryEditor?: boolean } = {}): void {
  requestSequence += 1;
  activeSelection = null;
  hideBubble();
  hidePopup();

  if (options.hideGlossaryEditor !== false) {
    hideGlossaryEditor();
  }
}

function clearTransientSelectionUi(): void {
  clearSelectionUi({ hideGlossaryEditor: false });
}

async function saveGlossaryTermFromEditor(): Promise<void> {
  const editor = getGlossaryEditor();
  const sourceInput = editor.querySelector<HTMLInputElement>("input[name='source']");
  const targetInput = editor.querySelector<HTMLInputElement>("input[name='target']");
  const feedback = editor.querySelector<HTMLElement>(".litetrace-glossary-feedback");
  const saveButton = editor.querySelector<HTMLButtonElement>(".litetrace-glossary-save");

  if (!sourceInput || !targetInput || !feedback || !saveButton) {
    return;
  }

  try {
    saveButton.disabled = true;
    feedback.textContent = "正在保存…";
    const term = await upsertContentGlossaryTerm({
      sourceText: sourceInput.value,
      targetText: targetInput.value
    });
    feedback.textContent = "已保存";
    if (immersiveLoading) {
      rememberPendingGlossaryRetouchTerm(term);
    }
    void retranslateImmersiveBlocksForGlossaryTerm(term);
    window.setTimeout(() => {
      if (feedback.textContent === "已保存") {
        hideGlossaryEditor();
      }
    }, 650);
  } catch (error) {
    feedback.textContent =
      error instanceof Error ? error.message : "术语保存失败，请稍后重试。";
    saveButton.disabled = false;
  }
}

function resetPageStateAfterUrlChange(): void {
  const loadingJobId = immersiveLoading ? immersiveJobId : null;

  immersiveJobId += 1;
  immersiveLoading = false;
  immersiveProgress = null;
  pendingGlossaryRetouchTerms = [];
  clearImmersiveTranslations(document);
  clearSelectionUi();
  syncImmersiveBubbleState();

  if (loadingJobId !== null) {
    void cancelImmersiveTranslation(loadingJobId).catch(() => {
      // Stale responses are still ignored by the incremented job id.
    });
  }
}

function checkPageUrlChange(): void {
  const nextUrl = window.location.href;

  if (nextUrl === currentPageUrl) {
    return;
  }

  currentPageUrl = nextUrl;
  resetPageStateAfterUrlChange();
}

function getSelectionRect(selection: Selection): DOMRect | null {
  if (selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  if (rect.width > 0 || rect.height > 0) {
    return rect;
  }

  const rects = range.getClientRects();
  return rects[0] ?? null;
}

function isSameRect(left: DOMRect | null, right: DOMRect | null): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height
  );
}

function isSameSelectionSnapshot(
  left: SelectionSnapshot | null,
  right: SelectionSnapshot | null
): boolean {
  if (!left || !right) {
    return false;
  }

  return (
    left.text === right.text &&
    left.fallbackPlacement === right.fallbackPlacement &&
    isSameRect(left.rect, right.rect)
  );
}

function createSelectionSnapshot(selection: Selection): SelectionSnapshot | null {
  if (selection.isCollapsed) {
    return null;
  }

  if (isEditableNode(selection.anchorNode) || isEditableNode(selection.focusNode)) {
    return null;
  }

  const text = normalizeText(selection.toString());

  if (!isTranslatableSelectionText(text)) {
    return null;
  }

  return {
    text,
    rect: getSelectionRect(selection),
    key: text
  };
}

function createFallbackSelectionSnapshot(text?: string): SelectionSnapshot | null {
  const normalized = normalizeText(text ?? "");

  if (!isTranslatableSelectionText(normalized)) {
    return null;
  }

  return {
    text: normalized,
    rect: null,
    key: `fallback:${normalized}`,
    fallbackPlacement: "viewport-top-right"
  };
}

async function requestTranslation(texts: string[]): Promise<TranslationResponse> {
  return chrome.runtime.sendMessage({
    type: texts.length > 1 ? "TRANSLATE_PAGE_BLOCKS" : "TRANSLATE_SELECTION",
    payload: {
      texts,
      scene: texts.length > 1 ? "page" : "selection"
    }
  } satisfies RuntimeMessage);
}

async function requestPageTranslation(
  texts: string[],
  immersiveJobId: number
): Promise<TranslationResponse> {
  return chrome.runtime.sendMessage({
    type: "TRANSLATE_PAGE_BLOCKS",
    payload: {
      texts,
      scene: "page",
      immersiveJobId
    }
  } satisfies RuntimeMessage);
}

async function cancelImmersiveTranslation(immersiveJobId: number): Promise<void> {
  await chrome.runtime.sendMessage({
    type: "CANCEL_IMMERSIVE_TRANSLATION",
    payload: { immersiveJobId }
  } satisfies RuntimeMessage);
}

function createImmersiveProgress(
  overrides?: Partial<ImmersiveProgress>
): ImmersiveProgress {
  return {
    totalCount: 0,
    completedCount: 0,
    insertedCount: 0,
    cacheHits: 0,
    ...overrides
  };
}

function updateImmersiveProgress(
  updates: Partial<ImmersiveProgress>
): ImmersiveProgress {
  immersiveProgress = createImmersiveProgress({
    ...immersiveProgress,
    ...updates
  });
  return immersiveProgress;
}

function getPageImmersiveState(): {
  ok: true;
  immersiveActive: boolean;
  immersiveLoading: boolean;
  progress?: ImmersiveProgress;
} {
  return {
    ok: true,
    immersiveActive: hasImmersiveTranslations(document),
    immersiveLoading,
    progress: immersiveProgress ?? undefined
  };
}

function buildImmersiveBatches(
  groups: GroupedTranslatableBlocks[]
): GroupedTranslatableBlocks[][] {
  const [firstBatch] = chunkTextLikeItems(groups, {
    maxItems: FIRST_IMMERSIVE_BATCH_MAX_ITEMS,
    maxChars: FIRST_IMMERSIVE_BATCH_MAX_CHARS
  });

  if (!firstBatch) {
    return [];
  }

  return [
    firstBatch,
    ...chunkTextLikeItems(groups.slice(firstBatch.length), {
      maxItems: STEADY_IMMERSIVE_BATCH_MAX_ITEMS,
      maxChars: STEADY_IMMERSIVE_BATCH_MAX_CHARS
    })
  ];
}

function applyGroupedTranslations(
  blocks: TranslatableBlock[],
  groups: GroupedTranslatableBlocks[],
  translations: string[]
): number {
  const expandedBlocks: TranslatableBlock[] = [];
  const expandedTranslations: string[] = [];

  groups.forEach((group, index) => {
    const translation = translations[index]?.trim();

    if (!translation) {
      return;
    }

    group.blockIndexes.forEach((blockIndex) => {
      const block = blocks[blockIndex];

      if (!block) {
        return;
      }

      expandedBlocks.push(block);
      expandedTranslations.push(translation);
    });
  });

  return applyImmersiveTranslations(expandedBlocks, expandedTranslations);
}

function collectImmersiveBlocksMatchingGlossaryTerm(
  term: GlossaryTerm
): TranslatableBlock[] {
  return Array.from(document.querySelectorAll<HTMLElement>(SOURCE_SELECTOR))
    .filter((element) => {
      const nextElement = element.nextElementSibling;

      return (
        nextElement instanceof HTMLElement &&
        nextElement.dataset.litetraceTranslation === "true" &&
        doesGlossaryTermMatchText(
          term.sourceText,
          normalizeText(element.innerText ?? element.textContent ?? "")
        )
      );
    })
    .map((element) => ({
      element,
      text: normalizeText(element.innerText ?? element.textContent ?? "")
    }))
    .filter((block) => block.text);
}

function rememberPendingGlossaryRetouchTerm(term: GlossaryTerm): void {
  const sourceKey = normalizeGlossarySource(term.sourceText);
  pendingGlossaryRetouchTerms = [
    term,
    ...pendingGlossaryRetouchTerms.filter(
      (existingTerm) =>
        normalizeGlossarySource(existingTerm.sourceText) !== sourceKey
    )
  ];
}

function retranslatePendingGlossaryTerms(): void {
  if (pendingGlossaryRetouchTerms.length === 0) {
    return;
  }

  for (const term of pendingGlossaryRetouchTerms) {
    void retranslateImmersiveBlocksForGlossaryTerm(term);
  }
}

async function retranslateImmersiveBlocksForGlossaryTerm(
  term: GlossaryTerm
): Promise<void> {
  const blocks = collectImmersiveBlocksMatchingGlossaryTerm(term);

  if (blocks.length === 0) {
    syncImmersiveBubbleState();
    return;
  }

  const groups = groupTranslatableBlocks(blocks);
  const wasLoading = immersiveLoading;
  const retouchJobId = wasLoading ? immersiveJobId : ++immersiveJobId;

  if (!wasLoading) {
    immersiveLoading = true;
    immersiveProgress = createImmersiveProgress({
      totalCount: groups.length,
      completedCount: 0,
      insertedCount: blocks.length,
      cacheHits: 0
    });
    syncImmersiveBubbleState();
  }

  try {
    const response = await requestPageTranslation(
      groups.map((group) => group.text),
      retouchJobId
    );

    if (retouchJobId !== immersiveJobId) {
      return;
    }

    if (!response.ok) {
      showToast(`术语已保存，但相关段落暂时没能重译：${response.error.message}`);
      return;
    }

    const appliedCount = applyGroupedTranslations(blocks, groups, response.translations);

    if (!wasLoading) {
      immersiveProgress = createImmersiveProgress({
        totalCount: groups.length,
        completedCount: groups.length,
        insertedCount: appliedCount,
        cacheHits: response.meta?.cacheHits ?? 0
      });
    }
  } catch {
    if (retouchJobId === immersiveJobId) {
      showToast("术语已保存，但相关段落重译失败，请稍后再试。");
    }
  } finally {
    if (!wasLoading && retouchJobId === immersiveJobId) {
      immersiveLoading = false;
      immersiveProgress = null;
      syncImmersiveBubbleState();
    } else {
      syncImmersiveBubbleState();
    }
  }
}

async function runImmersiveTranslationJob(currentJobId: number): Promise<void> {
  let appliedCount = 0;
  let completedUniqueCount = 0;
  let cacheHitCount = 0;
  let failure: ImmersiveFailureState | null = null;

  const isCurrentJob = (): boolean => currentJobId === immersiveJobId;
  const syncProgress = (totalCount: number): void => {
    updateImmersiveProgress({
      totalCount,
      completedCount: completedUniqueCount,
      insertedCount: appliedCount,
      cacheHits: cacheHitCount
    });
  };
  const showFailure = (failedState: ImmersiveFailureState): void => {
    const retainedMessage =
      appliedCount > 0 ? "\n已完成的译文会保留在页面上。" : "";

    showToast(
      `${failedState.message}${retainedMessage}`,
      failedState.action === "open-options" ? "打开设置" : undefined,
      failedState.action === "open-options" ? openOptionsPage : undefined,
      5600
    );
  };

  try {
    if (!isCurrentJob()) {
      return;
    }

    const blocks = prioritizeTranslatableBlocks(
      collectTranslatableBlocks(document)
    );

    if (!isCurrentJob()) {
      return;
    }

    if (blocks.length === 0) {
      immersiveProgress = null;
      immersiveLoading = false;
      showToast("当前页面没有识别到可处理的英文正文。");
      return;
    }

    const groupedBlocks = groupTranslatableBlocks(blocks);
    const batches = buildImmersiveBatches(groupedBlocks);
    syncProgress(groupedBlocks.length);
    syncImmersiveBubbleState();

    async function translateBatch(
      batch: GroupedTranslatableBlocks[]
    ): Promise<boolean> {
      let response: TranslationResponse;

      try {
        response = await requestPageTranslation(
          batch.map((group) => group.text),
          currentJobId
        );
      } catch {
        failure = {
          message: "生成双语阅读时中途断开了，请重新点击扩展图标再试一次。"
        };
        return false;
      }

      if (!isCurrentJob() || failure) {
        return false;
      }

      if (!response.ok) {
        failure = {
          message: `这次没能完成双语阅读：${response.error.message}`,
          action: response.error.action
        };
        return false;
      }

      appliedCount += applyGroupedTranslations(
        blocks,
        batch,
        response.translations
      );
      retranslatePendingGlossaryTerms();
      completedUniqueCount += batch.length;
      cacheHitCount += response.meta?.cacheHits ?? 0;
      syncProgress(groupedBlocks.length);
      syncImmersiveBubbleState();
      return true;
    }

    const [firstBatch, ...remainingBatches] = batches;

    if (firstBatch) {
      const firstBatchDone = await translateBatch(firstBatch);

      if (!firstBatchDone) {
        if (isCurrentJob() && failure) {
          showFailure(failure);
        }

        return;
      }

      syncImmersiveBubbleState();
    }

    let nextBatchIndex = 0;

    async function runBatchWorker(): Promise<void> {
      while (isCurrentJob() && !failure) {
        const batch = remainingBatches[nextBatchIndex];

        if (!batch) {
          return;
        }

        nextBatchIndex += 1;
        await translateBatch(batch);
      }
    }

    await Promise.all(
      Array.from(
        {
          length: Math.min(
            STEADY_IMMERSIVE_BATCH_CONCURRENCY,
            remainingBatches.length
          )
        },
        () => runBatchWorker()
      )
    );

    if (!isCurrentJob()) {
      return;
    }

    if (failure) {
      showFailure(failure);
      return;
    }

    if (appliedCount === 0) {
      immersiveProgress = null;
      showToast("当前接口返回了异常结果，这一页暂时没能生成双语对照。");
      return;
    }

    syncImmersiveBubbleState();
  } finally {
    if (isCurrentJob()) {
      immersiveLoading = false;
      pendingGlossaryRetouchTerms = [];

      if (!hasImmersiveTranslations(document)) {
        immersiveProgress = null;
      }

      syncImmersiveBubbleState();
    }
  }
}

function toggleImmersiveTranslation(): { ok: true } {
  if (immersiveLoading) {
    const activeJobId = immersiveJobId;
    immersiveJobId += 1;
    immersiveLoading = false;
    pendingGlossaryRetouchTerms = [];
    const insertedCount =
      immersiveProgress?.insertedCount ??
      document.querySelectorAll("[data-litetrace-translation]").length;

    if (insertedCount === 0) {
      immersiveProgress = null;
    }

    void cancelImmersiveTranslation(activeJobId).catch(() => {
      // Ignore cancellation transport failures; stale responses are still gated by job id.
    });

    syncImmersiveBubbleState();
    return { ok: true };
  }

  if (hasImmersiveTranslations(document)) {
    immersiveJobId += 1;
    const removedCount = clearImmersiveTranslations(document);
    immersiveProgress = null;
    pendingGlossaryRetouchTerms = [];
    if (removedCount === 0) {
      showToast("当前页面没有需要关闭的双语对照。");
    }
    syncImmersiveBubbleState();
    return { ok: true };
  }

  const currentJobId = ++immersiveJobId;
  immersiveLoading = true;
  immersiveProgress = createImmersiveProgress();
  pendingGlossaryRetouchTerms = [];
  syncImmersiveBubbleState();

  window.setTimeout(() => {
    void runImmersiveTranslationJob(currentJobId).catch(() => {
      if (currentJobId !== immersiveJobId) {
        return;
      }

      immersiveLoading = false;
      if (!hasImmersiveTranslations(document)) {
        immersiveProgress = null;
      }
      showToast("当前页面的双语阅读切换失败了，请稍后重试。");
      syncImmersiveBubbleState();
    });
  }, 0);

  return { ok: true };
}

async function translateSelectionSnapshot(snapshot: SelectionSnapshot): Promise<void> {
  activeSelection = snapshot;
  hideBubble();
  renderPopup("正在理解这段英文，并生成附近可直接查看的中文对照…", {
    rect: snapshot.rect,
    fallbackPlacement: snapshot.fallbackPlacement
  });

  const sequence = ++requestSequence;
  let response: TranslationResponse;

  try {
    response = await requestTranslation([snapshot.text]);
  } catch {
    if (sequence !== requestSequence || !isSameSelectionSnapshot(activeSelection, snapshot)) {
      return;
    }

    renderPopup("这次没有成功返回译文，请重试，或刷新页面后再试。", {
      rect: snapshot.rect,
      fallbackPlacement: snapshot.fallbackPlacement
    });
    return;
  }

  if (sequence !== requestSequence || !isSameSelectionSnapshot(activeSelection, snapshot)) {
    return;
  }

  if (!response.ok) {
    renderPopup(response.error.message, {
      rect: snapshot.rect,
      fallbackPlacement: snapshot.fallbackPlacement,
      actionLabel: response.error.action === "open-options" ? "打开设置" : undefined,
      action:
        response.error.action === "open-options"
          ? openOptionsPage
          : undefined
    });
    return;
  }

  renderPopup(response.translations[0], {
    rect: snapshot.rect,
    fallbackPlacement: snapshot.fallbackPlacement,
    showCopy: true
  });
}

async function triggerSelectionTranslationFromMessage(text?: string): Promise<void> {
  const currentSelection = window.getSelection();
  const snapshot =
    (currentSelection ? createSelectionSnapshot(currentSelection) : null) ??
    createFallbackSelectionSnapshot(text);

  if (!snapshot) {
    clearSelectionUi();
    renderPopup("这次没有检测到可翻译的英文内容，请重新选中后再试。", {
      fallbackPlacement: "viewport-top-right"
    });
    return;
  }

  activeSelection = snapshot;
  void translateSelectionSnapshot(snapshot);
}

async function openGlossaryTermEditorFromMessage(text?: string): Promise<void> {
  const currentSelection = window.getSelection();
  const snapshot =
    (currentSelection ? createSelectionSnapshot(currentSelection) : null) ??
    createFallbackSelectionSnapshot(text);

  if (!snapshot) {
    clearSelectionUi();
    showToast("这次没有检测到可加入术语库的英文内容。");
    return;
  }

  renderGlossaryEditor(snapshot);
}

async function updateSelectionUi(): Promise<void> {
  const selection = window.getSelection();
  const snapshot = selection ? createSelectionSnapshot(selection) : null;

  if (!snapshot) {
    clearTransientSelectionUi();
    return;
  }

  const hasChanged = !isSameSelectionSnapshot(activeSelection, snapshot);
  activeSelection = snapshot;

  if (hasChanged) {
    hidePopup();
  } else if (popupEl?.hidden === false) {
    return;
  }

  renderBubble(snapshot);
}

function scheduleSelectionTranslation(): void {
  if (selectionTimer) {
    window.clearTimeout(selectionTimer);
  }

  selectionTimer = window.setTimeout(() => {
    void updateSelectionUi();
  }, 180);
}

function handleSelectionChange(): void {
  const selection = window.getSelection();

  if (uiInteraction) {
    return;
  }

  if (glossaryEditorEl?.hidden === false) {
    return;
  }

  if (!selection || selection.isCollapsed) {
    clearTransientSelectionUi();
  }
}

function handleDocumentMouseDown(event: MouseEvent): void {
  const popup = getPopup();
  const bubble = getBubble();
  const immersiveBubble = getImmersiveBubble();
  const glossaryEditor = getGlossaryEditor();

  if (
    event.target instanceof Node &&
    !popup.contains(event.target) &&
    !bubble.contains(event.target) &&
    !immersiveBubble.contains(event.target) &&
    !glossaryEditor.contains(event.target)
  ) {
    clearTransientSelectionUi();
  }
}

function initialize(): void {
  injectStyles();
  getBubble();
  getImmersiveBubble();
  getPopup();
  getGlossaryEditor();
  getToast();

  document.addEventListener("mouseup", (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
    scheduleSelectionTranslation();
  });
  document.addEventListener("contextmenu", (event) => {
    lastPointer = { x: event.clientX, y: event.clientY };
  });

  document.addEventListener("selectionchange", handleSelectionChange);
  document.addEventListener("mousedown", handleDocumentMouseDown, true);
  window.addEventListener("scroll", () => {
    clearTransientSelectionUi();
  }, true);
  window.addEventListener("resize", () => {
    if (immersiveBubbleYRatio !== null) {
      applyImmersiveBubbleYRatio(immersiveBubbleYRatio);
    }
  });
  window.addEventListener("popstate", checkPageUrlChange);
  window.addEventListener("hashchange", checkPageUrlChange);
  window.addEventListener("pageshow", checkPageUrlChange);
  window.setInterval(checkPageUrlChange, PAGE_URL_CHECK_INTERVAL_MS);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      clearSelectionUi();
    }
  });
  chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
    if (message.type === "TOGGLE_IMMERSIVE_TRANSLATION") {
      try {
        sendResponse(toggleImmersiveTranslation());
      } catch {
        showToast("当前页面的双语阅读切换失败了，请稍后重试。");
        sendResponse({ ok: true });
      }
      return true;
    }

    if (message.type === "GET_PAGE_IMMERSIVE_STATE") {
      sendResponse(getPageImmersiveState());
      return true;
    }

    if (message.type === "TRIGGER_SELECTION_TRANSLATION") {
      void triggerSelectionTranslationFromMessage(message.payload?.text).finally(() => {
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.type === "OPEN_GLOSSARY_TERM_EDITOR") {
      void openGlossaryTermEditorFromMessage(message.payload?.text).finally(() => {
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.type === "PING") {
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });
}

const contentWindow = window as LiteTraceWindow;

// Recovery injection can execute the same content script more than once on a page.
if (!contentWindow[CONTENT_RUNTIME_FLAG]) {
  contentWindow[CONTENT_RUNTIME_FLAG] = true;
  initialize();
}
