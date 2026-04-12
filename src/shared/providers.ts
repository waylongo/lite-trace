import { getPermissionOriginsForProvider, normalizeOpenAIBaseUrl } from "./settings";
import {
  getCachedTranslations,
  setCachedTranslations
} from "./translation-cache";
import {
  mapTranslationConcurrency,
  normalizeTranslationText
} from "./translation-runtime";
import type {
  ExtensionSettings,
  TranslationError,
  TranslationMeta
} from "./types";

const GOOGLE_ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
const SINGLE_FALLBACK_CONCURRENCY = 4;

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

export class TranslationProviderError extends Error {
  readonly details: TranslationError;

  constructor(details: TranslationError) {
    super(details.message);
    this.name = "TranslationProviderError";
    this.details = details;
  }
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

export function createOpenAIRequest(texts: string[], settings: ExtensionSettings) {
  const baseUrl = normalizeOpenAIBaseUrl(settings.openai.baseUrl);
  const requestBody: Record<string, unknown> = {
    model: settings.openai.model,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content:
          "You are a translation engine. Translate English text into Simplified Chinese. Return only the final translation result. Prefer strict JSON in the shape {\"translations\":[\"...\"]}. Do not output reasoning, analysis, <think> tags, markdown fences, or extra commentary."
      },
      {
        role: "user",
        content: JSON.stringify({
          targetLanguage: settings.preferences.targetLang,
          count: texts.length,
          texts
        })
      }
    ]
  };

  if (supportsJsonResponseFormat(baseUrl)) {
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
  throwProviderError(
    "PROVIDER_ERROR",
    errorText || `远程接口返回错误状态 ${response.status}。`
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
  fetcher: typeof fetch
): Promise<string> {
  const request = createOpenAIRequest(texts, settings);
  const response = await fetcher(request.url, request.init);
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

async function requestGoogleTranslations(
  texts: string[],
  settings: ExtensionSettings,
  fetcher: typeof fetch
): Promise<RemoteTranslationResult> {
  const request = createGoogleRequest(texts, settings);
  const response = await fetcher(request.url, request.init);
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
  fetcher: typeof fetch,
  permissionsChecked = false
): Promise<RemoteTranslationResult> {
  try {
    const content = await requestOpenAIMessageContent(texts, settings, fetcher);
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
      const singleResults = await mapTranslationConcurrency(
        texts,
        SINGLE_FALLBACK_CONCURRENCY,
        async (text) =>
          await translateTextsDetailed(
            [text],
            settings,
            fetcher,
            permissionsChecked
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

export async function translateTextsDetailed(
  texts: string[],
  settings: ExtensionSettings,
  fetcher: typeof fetch = fetch,
  permissionsChecked = false
): Promise<TranslationExecutionResult> {
  if (!permissionsChecked) {
    await ensureProviderPermission(settings);
  }

  try {
    const cachedResult = await getCachedTranslations(settings, texts);
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
    const remoteResult =
      settings.activeProvider === "google"
        ? await requestGoogleTranslations(missingTexts, settings, fetcher)
        : await translateOpenAITexts(
            missingTexts,
            settings,
            fetcher,
            true
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
      }))
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

    if (error instanceof TypeError) {
      throwProviderError("NETWORK_ERROR", "网络请求失败，请检查接口地址、权限或网络状态。");
    }

    throwProviderError("UNKNOWN_ERROR", "翻译请求失败，请稍后重试。");
  }
}

export async function translateTexts(
  texts: string[],
  settings: ExtensionSettings,
  fetcher: typeof fetch = fetch
): Promise<string[]> {
  const result = await translateTextsDetailed(texts, settings, fetcher);
  return result.translations;
}
