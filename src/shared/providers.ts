import { getPermissionOriginsForProvider, normalizeOpenAIBaseUrl } from "./settings";
import {
  getGlossaryTerms,
  getMatchedGlossaryTerms
} from "./glossary";
import {
  getCachedTranslations,
  setCachedTranslations
} from "./translation-cache";
import { normalizeTranslationText } from "./translation-runtime";
import type {
  ExtensionSettings,
  GlossaryTerm,
  TranslationError,
  TranslationMeta,
  TranslationScene
} from "./types";

const GOOGLE_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
const SINGLE_FALLBACK_CONCURRENCY = 4;
const TRANSIENT_RETRY_DELAYS_MS = [300, 900] as const;
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const openAICompatibilityModeCache = new Map<string, "rich" | "compat-minimal">();

interface MissingTextGroup {
  text: string;
  indexes: number[];
}

interface RemoteTranslationResult {
  translations: string[];
  meta: Pick<TranslationMeta, "cacheHits" | "networkCount">;
}

interface TranslationExecutionResult {
  translations: string[];
  meta: TranslationMeta;
}

function buildOpenAICompatibilityCacheKey(settings: ExtensionSettings): string {
  return [
    normalizeOpenAIBaseUrl(settings.openai.baseUrl),
    settings.openai.model.trim()
  ].join("\u241F");
}

async function mapWithConcurrency<T, TResult>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<TResult>
): Promise<TResult[]> {
  const limit = Math.max(1, concurrency);
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;

      if (currentIndex >= items.length) {
        return;
      }

      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function isRetryableStatus(status: number): boolean {
  return TRANSIENT_HTTP_STATUSES.has(status);
}

function isRetryableFetchError(error: unknown): boolean {
  return error instanceof TypeError && !isAbortError(error);
}

function isTransientProviderFailureMessage(message: string): boolean {
  return (
    /暂时不可用（(?:408|429|500|502|503|504)）/.test(message) ||
    /请求过多/.test(message) ||
    /远程接口返回错误状态 (?:408|429|500|502|503|504)/.test(message)
  );
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };

    const cleanup = (): void => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

async function fetchWithTransientRetry(
  url: string,
  init: RequestInit,
  fetcher: typeof fetch,
  signal?: AbortSignal
): Promise<Response> {
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetcher(url, {
        ...init,
        signal
      });

      if (response.ok || !isRetryableStatus(response.status) || attempt === TRANSIENT_RETRY_DELAYS_MS.length) {
        return response;
      }

      await response.text().catch(() => "");
    } catch (error) {
      if (!isRetryableFetchError(error) || attempt === TRANSIENT_RETRY_DELAYS_MS.length) {
        throw error;
      }
    }

    await waitForRetry(TRANSIENT_RETRY_DELAYS_MS[attempt] ?? 0, signal);
  }

  throw new Error("网络请求失败，请稍后重试。");
}

export class TranslationProviderError extends Error {
  readonly details: TranslationError;

  constructor(details: TranslationError) {
    super(details.message);
    this.name = "TranslationProviderError";
    this.details = details;
  }
}

export function resetProviderRuntimeState(): void {
  openAICompatibilityModeCache.clear();
}

export function createGoogleRequest(texts: string[], settings: ExtensionSettings) {
  const url = `${GOOGLE_ENDPOINT}?key=${encodeURIComponent(settings.google.apiKey)}`;

  return {
    url,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        q: texts,
        source: "en",
        target: settings.preferences.targetLang,
        format: "text"
      })
    } satisfies RequestInit
  };
}

function buildOpenAISystemPrompt(scene: TranslationScene): string {
  if (scene === "selection") {
    return [
      "You are an expert English-to-Simplified-Chinese translation engine for selection-based lookup.",
      "The user has actively highlighted a word, phrase, sentence, or short passage and wants an immediate, native-sounding Chinese rendering.",
      "Produce faithful, fluent, and idiomatic Simplified Chinese.",
      "For words, short phrases, titles, and UI text, prefer concise and natural Chinese phrasing instead of stiff literal translation.",
      "For sentences, preserve the original meaning, tone, names, brands, numbers, units, and technical terms.",
      "When the user provides glossary entries, follow those English-to-Chinese terminology preferences exactly where they fit the source text.",
      "Do not add explanations, notes, examples, transliteration, or dictionary labels unless they already appear in the source text.",
      'Return only JSON in the exact shape {"translations":["..."]}.',
      "Keep the same item order and item count as the input.",
      "Do not output reasoning, notes, analysis, markdown fences, or extra commentary."
    ].join(" ");
  }

  return [
    "You are an expert English-to-Simplified-Chinese translation engine for immersive bilingual reading.",
    "Translate each passage into fluent, idiomatic Simplified Chinese that reads naturally for native Chinese readers.",
    "Preserve meaning, tone, structure, names, brands, numbers, units, and technical terminology.",
    "When the user provides glossary entries, follow those English-to-Chinese terminology preferences exactly where they fit the source text.",
    "Prefer smooth Chinese sentence flow over rigid word-for-word mirroring, but do not add or omit meaning.",
    "Keep paragraph-level readability strong so the translation can sit directly under the original text for side-by-side reading.",
    'Return only JSON in the exact shape {"translations":["..."]}.',
    "Keep the same item order and item count as the input.",
    "Do not output reasoning, notes, analysis, markdown fences, or extra commentary."
  ].join(" ");
}

export function createOpenAIRequest(
  texts: string[],
  settings: ExtensionSettings,
  scene: TranslationScene = "selection",
  mode: "rich" | "compat-minimal" = "rich",
  glossaryTerms: GlossaryTerm[] = []
) {
  const baseUrl = normalizeOpenAIBaseUrl(settings.openai.baseUrl);
  const matchedGlossary = getMatchedGlossaryTerms(texts, glossaryTerms);
  const userContent =
    mode === "compat-minimal"
      ? [
          `targetLanguage: ${settings.preferences.targetLang}`,
          `scene: ${scene}`,
          `count: ${texts.length}`,
          matchedGlossary.length > 0
            ? [
                "glossary:",
                ...matchedGlossary.map(
                  (term) => `- ${term.sourceText} => ${term.targetText}`
                )
              ].join("\n")
            : "",
          "texts:",
          ...texts.map((text, index) => `[${index + 1}] ${text}`)
        ]
          .filter(Boolean)
          .join("\n")
      : JSON.stringify({
          scene,
          targetLanguage: settings.preferences.targetLang,
          audience: "简体中文母语读者",
          style:
            scene === "selection"
              ? "适合划词即看，忠实原意、简洁自然、避免生硬直译"
              : "适合整段阅读，忠实原意、自然流畅、符合中文表达习惯",
          glossary: matchedGlossary.map((term) => ({
            source: term.sourceText,
            target: term.targetText
          })),
          output: {
            format: "json",
            schema: {
              translations: ["string"]
            },
            preserveOrder: true,
            preserveCount: true
          },
          count: texts.length,
          texts
        });
  const requestBody: Record<string, unknown> = {
    model: settings.openai.model,
    messages: [
      {
        role: "system",
        content:
          mode === "compat-minimal"
            ? [
                "Translate English text into natural Simplified Chinese.",
                "Return JSON only in the exact shape {\"translations\":[\"...\"]}.",
                "Keep the same item order and item count as the input.",
                "Do not output reasoning or extra commentary."
              ].join(" ")
            : buildOpenAISystemPrompt(scene)
      },
      {
        role: "user",
        content: userContent
      }
    ]
  };

  if (mode === "rich") {
    requestBody.temperature = 0.1;
  }

  if (mode === "rich" && supportsJsonResponseFormat(baseUrl)) {
    requestBody.response_format = {
      type: "json_object"
    };
  }

  return {
    url: `${baseUrl}/chat/completions`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.openai.apiKey}`
      },
      body: JSON.stringify(requestBody)
    } satisfies RequestInit
  };
}

function shouldUseCompatibilityFallback(
  baseUrl: string,
  error: unknown
): boolean {
  if (supportsJsonResponseFormat(baseUrl)) {
    return false;
  }

  if (isRetryableFetchError(error)) {
    return true;
  }

  return (
    error instanceof TranslationProviderError &&
    (error.details.code === "PROVIDER_ERROR" ||
      error.details.code === "NETWORK_ERROR" ||
      error.details.code === "PARSE_ERROR")
  );
}

function getPreferredOpenAIRequestMode(
  settings: ExtensionSettings
): "rich" | "compat-minimal" {
  if (supportsJsonResponseFormat(normalizeOpenAIBaseUrl(settings.openai.baseUrl))) {
    return "rich";
  }

  return (
    openAICompatibilityModeCache.get(buildOpenAICompatibilityCacheKey(settings)) ?? "rich"
  );
}

function rememberOpenAIRequestMode(
  settings: ExtensionSettings,
  mode: "rich" | "compat-minimal"
): void {
  if (supportsJsonResponseFormat(normalizeOpenAIBaseUrl(settings.openai.baseUrl))) {
    return;
  }

  openAICompatibilityModeCache.set(
    buildOpenAICompatibilityCacheKey(settings),
    mode
  );
}

function throwProviderError(
  code: TranslationError["code"],
  message: string,
  action?: TranslationError["action"]
): never {
  throw new TranslationProviderError({ code, message, action });
}

function extractJsonPayload(rawText: string): string {
  const trimmed = rawText.trim();

  if (trimmed.startsWith("```")) {
    const withoutFence = trimmed
      .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
      .replace(/\s*```$/, "");
    return withoutFence.trim();
  }

  return trimmed;
}

function stripReasoningArtifacts(rawText: string): string {
  return rawText
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, " ")
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, " ")
    .replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, " ")
    .replace(/<\/?(?:think|thinking|reasoning)\b[^>]*>/gi, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function supportsJsonResponseFormat(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  return hostname === "api.openai.com" || hostname.endsWith(".openai.com");
}

function cleanTranslationText(text: string): string {
  let cleaned = stripReasoningArtifacts(text).trim();

  cleaned = cleaned.replace(
    /^(translation|translated text|translation result|translated result|译文|翻译)\s*[:：]\s*/i,
    ""
  );

  const wrappers: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["“", "”"],
    ["‘", "’"],
    ["「", "」"],
    ["『", "』"]
  ];

  for (const [open, close] of wrappers) {
    if (cleaned.startsWith(open) && cleaned.endsWith(close) && cleaned.length > 1) {
      cleaned = cleaned.slice(open.length, cleaned.length - close.length).trim();
      break;
    }
  }

  return cleaned;
}

function groupMissingTexts(
  texts: string[],
  existingTranslations: Array<string | null>
): MissingTextGroup[] {
  const groups = new Map<string, MissingTextGroup>();

  texts.forEach((text, index) => {
    if (existingTranslations[index]) {
      return;
    }

    const key = normalizeTranslationText(text);
    const existing = groups.get(key);

    if (existing) {
      existing.indexes.push(index);
      return;
    }

    groups.set(key, {
      text,
      indexes: [index]
    });
  });

  return Array.from(groups.values());
}

function normalizeTranslationsCandidate(
  candidate: unknown[],
  expectedLength: number
): string[] | null {
  const translations = candidate.map((item) =>
    typeof item === "string" ? cleanTranslationText(item) : ""
  );

  if (translations.length !== expectedLength || translations.some((item) => !item)) {
    return null;
  }

  return translations;
}

function parsePlainTextFallback(
  rawContent: string,
  expectedLength: number
): string[] | null {
  const raw = extractJsonPayload(rawContent);

  const numberedItems = Array.from(
    raw.matchAll(/(?:^|\n)\s*(?:[-*•]|\d+[.)]|[A-Za-z][.)])\s+([^\n]+)/g)
  )
    .map((match) => cleanTranslationText(match[1] ?? ""))
    .filter(Boolean);

  if (numberedItems.length === expectedLength) {
    return numberedItems;
  }

  const lines = raw
    .split(/\n+/)
    .map((line) => cleanTranslationText(line))
    .filter(Boolean);

  if (lines.length === expectedLength) {
    return lines;
  }

  if (expectedLength === 1) {
    const single = cleanTranslationText(raw.replace(/\s*\n+\s*/g, " "));
    return single ? [single] : null;
  }

  return null;
}

export function parseOpenAITranslations(
  content: string,
  expectedLength: number
): string[] {
  const raw = extractJsonPayload(stripReasoningArtifacts(content));
  const candidates = [raw];
  let foundTranslationsArray = false;

  const objectStart = raw.indexOf("{");
  const objectEnd = raw.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(raw.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = raw.indexOf("[");
  const arrayEnd = raw.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(raw.slice(arrayStart, arrayEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as
        | { translations?: unknown }
        | unknown[];
      const translations = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.translations)
          ? parsed.translations
          : null;

      if (!translations) {
        continue;
      }

      foundTranslationsArray = true;
      const normalized = normalizeTranslationsCandidate(translations, expectedLength);
      if (normalized) {
        return normalized;
      }
    } catch (error) {
      if (error instanceof TranslationProviderError) {
        throw error;
      }
    }
  }

  const plainTextFallback = parsePlainTextFallback(raw, expectedLength);
  if (plainTextFallback) {
    return plainTextFallback;
  }

  if (foundTranslationsArray) {
    throwProviderError("PARSE_ERROR", "LLM 返回的译文数量与请求不一致。");
  }

  throwProviderError("PARSE_ERROR", "无法解析 LLM 返回的译文。");
}

async function ensureResponseOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }

  const errorText = await response.text();
  const message =
    errorText ||
    (response.status === 502 || response.status === 503 || response.status === 504
      ? `远程翻译接口暂时不可用（${response.status}），请稍后重试。`
      : response.status === 429
        ? "远程翻译接口当前请求过多，请稍后重试。"
        : `远程接口返回错误状态 ${response.status}。`);

  throwProviderError(
    "PROVIDER_ERROR",
    message
  );
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractOpenAIMessageContent(content: unknown): string | null {
  if (typeof content === "string") {
    return stripReasoningArtifacts(content);
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const joined = content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (!part || typeof part !== "object") {
        return "";
      }

      if ("text" in part && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n");

  const sanitized = stripReasoningArtifacts(joined);
  return sanitized || null;
}

async function ensureProviderPermission(
  settings: ExtensionSettings
): Promise<void> {
  const permissionOrigins = getPermissionOriginsForProvider(settings);
  const hasPermission = await chrome.permissions.contains({ origins: permissionOrigins });

  if (!hasPermission) {
    throwProviderError(
      "PERMISSION_DENIED",
      "当前接口尚未授予网络访问权限，请前往设置页重新保存配置。",
      "open-options"
    );
  }
}

async function requestOpenAIMessageContent(
  texts: string[],
  settings: ExtensionSettings,
  scene: TranslationScene,
  fetcher: typeof fetch,
  signal?: AbortSignal,
  glossaryTerms: GlossaryTerm[] = []
): Promise<string> {
  async function requestWithMode(mode: "rich" | "compat-minimal"): Promise<string> {
    const request = createOpenAIRequest(
      texts,
      settings,
      scene,
      mode,
      glossaryTerms
    );
    const response = await fetchWithTransientRetry(
      request.url,
      request.init,
      fetcher,
      signal
    );
    await ensureResponseOk(response);

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = extractOpenAIMessageContent(data.choices?.[0]?.message?.content);

    if (!content) {
      throwProviderError("PARSE_ERROR", "LLM 未返回可解析的译文内容。");
    }

    return content;
  }

  const preferredMode = getPreferredOpenAIRequestMode(settings);

  try {
    const content = await requestWithMode(preferredMode);
    rememberOpenAIRequestMode(settings, preferredMode);
    return content;
  } catch (error) {
    if (
      preferredMode === "compat-minimal" ||
      !shouldUseCompatibilityFallback(normalizeOpenAIBaseUrl(settings.openai.baseUrl), error)
    ) {
      throw error;
    }

    const content = await requestWithMode("compat-minimal");
    rememberOpenAIRequestMode(settings, "compat-minimal");
    return content;
  }
}

async function requestGoogleTranslations(
  texts: string[],
  settings: ExtensionSettings,
  fetcher: typeof fetch,
  signal?: AbortSignal
): Promise<RemoteTranslationResult> {
  const request = createGoogleRequest(texts, settings);
  const response = await fetchWithTransientRetry(
    request.url,
    request.init,
    fetcher,
    signal
  );
  await ensureResponseOk(response);

  const data = (await response.json()) as {
    data?: { translations?: Array<{ translatedText?: string }> };
  };

  const translations = data.data?.translations?.map((item) =>
    decodeHtmlEntities(item.translatedText ?? "")
  );

  if (!translations || translations.length !== texts.length) {
    throwProviderError("PARSE_ERROR", "Google Translate 返回格式异常。");
  }

  return {
    translations,
    meta: {
      cacheHits: 0,
      networkCount: texts.length
    }
  };
}

async function translateOpenAITexts(
  texts: string[],
  settings: ExtensionSettings,
  scene: TranslationScene,
  fetcher: typeof fetch,
  permissionsChecked = false,
  signal?: AbortSignal,
  glossaryTerms: GlossaryTerm[] = []
): Promise<RemoteTranslationResult> {
  try {
    const content = await requestOpenAIMessageContent(
      texts,
      settings,
      scene,
      fetcher,
      signal,
      glossaryTerms
    );
    return {
      translations: parseOpenAITranslations(content, texts.length),
      meta: {
        cacheHits: 0,
        networkCount: texts.length
      }
    };
  } catch (error) {
    if (
      error instanceof TranslationProviderError &&
      error.details.code === "PARSE_ERROR" &&
      texts.length > 1
    ) {
      const singleResults = await mapWithConcurrency(
        texts,
        SINGLE_FALLBACK_CONCURRENCY,
        async (text) =>
          await translateTextsDetailed(
            [text],
            settings,
            fetcher,
            permissionsChecked,
            signal,
            scene
          )
      );

      return {
        translations: singleResults.map((result) => result.translations[0]),
        meta: {
          cacheHits: singleResults.reduce(
            (sum, result) => sum + result.meta.cacheHits,
            0
          ),
          networkCount: singleResults.reduce(
            (sum, result) => sum + result.meta.networkCount,
            0
          )
        }
      };
    }

    throw error;
  }
}

function shouldSplitBatchOnFailure(
  error: unknown,
  texts: string[],
  scene: TranslationScene
): boolean {
  if (scene !== "page" || texts.length <= 1 || isAbortError(error)) {
    return false;
  }

  if (isRetryableFetchError(error)) {
    return true;
  }

  return (
    error instanceof TranslationProviderError &&
    error.details.code === "PROVIDER_ERROR" &&
    isTransientProviderFailureMessage(error.details.message)
  );
}

async function requestRemoteTranslations(
  texts: string[],
  settings: ExtensionSettings,
  scene: TranslationScene,
  fetcher: typeof fetch,
  permissionsChecked: boolean,
  signal?: AbortSignal,
  glossaryTerms: GlossaryTerm[] = []
): Promise<RemoteTranslationResult> {
  return settings.activeProvider === "google"
    ? await requestGoogleTranslations(texts, settings, fetcher, signal)
    : await translateOpenAITexts(
        texts,
        settings,
        scene,
        fetcher,
        permissionsChecked,
        signal,
        glossaryTerms
      );
}

async function requestRemoteTranslationsWithBatchFallback(
  texts: string[],
  settings: ExtensionSettings,
  scene: TranslationScene,
  fetcher: typeof fetch,
  permissionsChecked: boolean,
  signal?: AbortSignal,
  glossaryTerms: GlossaryTerm[] = []
): Promise<RemoteTranslationResult> {
  try {
    return await requestRemoteTranslations(
      texts,
      settings,
      scene,
      fetcher,
      permissionsChecked,
      signal,
      glossaryTerms
    );
  } catch (error) {
    if (!shouldSplitBatchOnFailure(error, texts, scene)) {
      throw error;
    }

    const middle = Math.ceil(texts.length / 2);
    const leftTexts = texts.slice(0, middle);
    const rightTexts = texts.slice(middle);

    const leftResult = await requestRemoteTranslationsWithBatchFallback(
      leftTexts,
      settings,
      scene,
      fetcher,
      permissionsChecked,
      signal,
      glossaryTerms
    );
    const rightResult = await requestRemoteTranslationsWithBatchFallback(
      rightTexts,
      settings,
      scene,
      fetcher,
      permissionsChecked,
      signal,
      glossaryTerms
    );

    return {
      translations: [...leftResult.translations, ...rightResult.translations],
      meta: {
        cacheHits: leftResult.meta.cacheHits + rightResult.meta.cacheHits,
        networkCount: leftResult.meta.networkCount + rightResult.meta.networkCount
      }
    };
  }
}

export async function translateTextsDetailed(
  texts: string[],
  settings: ExtensionSettings,
  fetcher: typeof fetch = fetch,
  permissionsChecked = false,
  signal?: AbortSignal,
  scene: TranslationScene = "selection"
): Promise<TranslationExecutionResult> {
  if (!permissionsChecked) {
    await ensureProviderPermission(settings);
  }

  try {
    const glossaryTerms =
      settings.activeProvider === "openai" ? await getGlossaryTerms() : [];
    const cacheLookupGlossaryTerms =
      settings.activeProvider === "openai"
        ? getMatchedGlossaryTerms(texts, glossaryTerms)
        : [];
    const cachedResult = await getCachedTranslations(
      settings,
      texts,
      Date.now(),
      cacheLookupGlossaryTerms
    );
    const resolvedTranslations = [...cachedResult.translations];
    const missingGroups = groupMissingTexts(texts, resolvedTranslations);

    if (missingGroups.length === 0) {
      return {
        translations: resolvedTranslations as string[],
        meta: {
          cacheHits: cachedResult.hitCount,
          requestedCount: texts.length,
          networkCount: 0
        }
      };
    }

    const missingTexts = missingGroups.map((group) => group.text);
    const remoteGlossaryTerms =
      settings.activeProvider === "openai"
        ? getMatchedGlossaryTerms(missingTexts, glossaryTerms)
        : [];
    const remoteResult = await requestRemoteTranslationsWithBatchFallback(
      missingTexts,
      settings,
      scene,
      fetcher,
      true,
      signal,
      remoteGlossaryTerms
    );

    missingGroups.forEach((group, index) => {
      const translation = remoteResult.translations[index];

      if (!translation) {
        throwProviderError("PARSE_ERROR", "部分译文缺失，无法完成翻译。");
      }

      for (const originalIndex of group.indexes) {
        resolvedTranslations[originalIndex] = translation;
      }
    });

    await setCachedTranslations(
      settings,
      missingGroups.map((group, index) => ({
        text: group.text,
        translation: remoteResult.translations[index]
      })),
      Date.now(),
      remoteGlossaryTerms
    );

    return {
      translations: resolvedTranslations as string[],
      meta: {
        cacheHits: cachedResult.hitCount + remoteResult.meta.cacheHits,
        requestedCount: texts.length,
        networkCount: remoteResult.meta.networkCount
      }
    };
  } catch (error) {
    if (error instanceof TranslationProviderError) {
      throw error;
    }

    if (isAbortError(error)) {
      throw error;
    }

    if (error instanceof TypeError) {
      throwProviderError("NETWORK_ERROR", "网络请求失败，请检查接口地址、权限或网络状态。");
    }

    throwProviderError("UNKNOWN_ERROR", "翻译请求失败，请稍后重试。");
  }
}

export async function translateTexts(
  texts: string[],
  settings: ExtensionSettings,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  scene: TranslationScene = "selection"
): Promise<string[]> {
  const result = await translateTextsDetailed(
    texts,
    settings,
    fetcher,
    false,
    signal,
    scene
  );
  return result.translations;
}
