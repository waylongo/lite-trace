import {
  DEFAULT_SETTINGS,
  type ExtensionSettings,
  type ProviderKind
} from "./types";

const GOOGLE_PERMISSION = "https://translation.googleapis.com/*";

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function normalizeOpenAIBaseUrl(rawValue: string): string {
  let normalized = safeString(rawValue);

  if (!normalized) {
    return "";
  }

  normalized = normalized.replace(/\/chat\/completions\/?$/i, "");
  normalized = normalized.replace(/\/+$/, "");

  const url = new URL(normalized);
  return url.toString().replace(/\/$/, "");
}

export function sanitizeSettings(rawValue: unknown): ExtensionSettings {
  if (!isObject(rawValue)) {
    return structuredClone(DEFAULT_SETTINGS);
  }

  const activeProvider =
    rawValue.activeProvider === "openai" ? "openai" : "google";

  const googleSource = isObject(rawValue.google) ? rawValue.google : {};
  const openaiSource = isObject(rawValue.openai) ? rawValue.openai : {};
  const preferencesSource = isObject(rawValue.preferences)
    ? rawValue.preferences
    : {};

  return {
    activeProvider,
    google: {
      apiKey: safeString(googleSource.apiKey)
    },
    openai: {
      baseUrl: safeString(openaiSource.baseUrl),
      model: safeString(openaiSource.model),
      apiKey: safeString(openaiSource.apiKey)
    },
    preferences: {
      targetLang: "zh-CN",
      selectionUi: "auto-popup",
      pageScope: "static-content",
      hasCompletedSetup: Boolean(preferencesSource.hasCompletedSetup),
      hasSeenReadingCoachmark: Boolean(preferencesSource.hasSeenReadingCoachmark)
    }
  };
}

export function mergeSettings(
  rawValue: unknown,
  overrides?: Partial<ExtensionSettings>
): ExtensionSettings {
  const sanitized = sanitizeSettings(rawValue);

  return {
    ...sanitized,
    ...overrides,
    google: {
      ...sanitized.google,
      ...overrides?.google
    },
    openai: {
      ...sanitized.openai,
      ...overrides?.openai,
      baseUrl: overrides?.openai?.baseUrl
        ? normalizeOpenAIBaseUrl(overrides.openai.baseUrl)
        : normalizeOpenAIBaseUrl(sanitized.openai.baseUrl)
    },
    preferences: {
      ...sanitized.preferences,
      ...overrides?.preferences
    }
  };
}

export function validateSettings(settings: ExtensionSettings): string[] {
  const errors: string[] = [];

  if (settings.activeProvider === "google") {
    if (!settings.google.apiKey.trim()) {
      errors.push("Google Translate API Key 不能为空。");
    }
  }

  if (settings.activeProvider === "openai") {
    if (!settings.openai.baseUrl.trim()) {
      errors.push("OpenAI 兼容接口 Base URL 不能为空。");
    } else {
      try {
        normalizeOpenAIBaseUrl(settings.openai.baseUrl);
      } catch {
        errors.push("OpenAI 兼容接口 Base URL 格式无效。");
      }
    }

    if (!settings.openai.model.trim()) {
      errors.push("模型名称不能为空。");
    }

    if (!settings.openai.apiKey.trim()) {
      errors.push("OpenAI 兼容接口 API Key 不能为空。");
    }
  }

  return errors;
}

export function isProviderConfigured(settings: ExtensionSettings): boolean {
  return validateSettings(settings).length === 0;
}

export function getPermissionOriginsForProvider(
  settings: ExtensionSettings,
  provider: ProviderKind = settings.activeProvider
): string[] {
  if (provider === "google") {
    return [GOOGLE_PERMISSION];
  }

  const normalizedBaseUrl = normalizeOpenAIBaseUrl(settings.openai.baseUrl);
  const origin = new URL(normalizedBaseUrl).origin;

  return [`${origin}/*`];
}

export function getCurrentProviderLabel(provider: ProviderKind): string {
  return provider === "google"
    ? "Google Translate API"
    : "OpenAI 兼容接口";
}
