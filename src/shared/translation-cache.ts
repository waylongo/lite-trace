import { normalizeOpenAIBaseUrl } from "./settings";
import { normalizeTranslationText } from "./translation-runtime";
import type { ExtensionSettings } from "./types";

export const TRANSLATION_CACHE_PREFIX = "litetrace.cache.entry.";
export const TRANSLATION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TRANSLATION_CACHE_MAX_ENTRIES = 2_000;

const CACHE_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const CACHE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

let lastPrunedAt = 0;

export interface TranslationCacheEntry {
  translation: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface CachedTranslationsResult {
  translations: Array<string | null>;
  hitCount: number;
}

function isTranslationCacheEntry(value: unknown): value is TranslationCacheEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<TranslationCacheEntry>;
  return (
    typeof candidate.translation === "string" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.lastUsedAt === "number"
  );
}

function createIdentityString(
  settings: ExtensionSettings,
  text: string
): string {
  return [
    settings.activeProvider,
    settings.activeProvider === "google"
      ? "google-translate"
      : normalizeOpenAIBaseUrl(settings.openai.baseUrl),
    settings.activeProvider === "google" ? "" : settings.openai.model.trim(),
    settings.preferences.targetLang,
    normalizeTranslationText(text)
  ].join("\u241F");
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function buildTranslationCacheKey(
  settings: ExtensionSettings,
  text: string
): Promise<string> {
  const hash = await sha256Hex(createIdentityString(settings, text));
  return `${TRANSLATION_CACHE_PREFIX}${hash}`;
}

export async function getCachedTranslations(
  settings: ExtensionSettings,
  texts: string[],
  now = Date.now()
): Promise<CachedTranslationsResult> {
  if (texts.length === 0) {
    return {
      translations: [],
      hitCount: 0
    };
  }

  const keys = await Promise.all(
    texts.map((text) => buildTranslationCacheKey(settings, text))
  );
  const stored = await chrome.storage.local.get(keys);
  const translations = new Array<string | null>(texts.length).fill(null);
  const touchUpdates: Record<string, TranslationCacheEntry> = {};
  const keysToRemove: string[] = [];
  let hitCount = 0;

  keys.forEach((key, index) => {
    const entry = stored[key];

    if (!isTranslationCacheEntry(entry)) {
      return;
    }

    if (now - entry.createdAt > TRANSLATION_CACHE_TTL_MS) {
      keysToRemove.push(key);
      return;
    }

    translations[index] = entry.translation;
    hitCount += 1;

    if (now - entry.lastUsedAt >= CACHE_TOUCH_INTERVAL_MS) {
      touchUpdates[key] = {
        ...entry,
        lastUsedAt: now
      };
    }
  });

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }

  if (Object.keys(touchUpdates).length > 0) {
    await chrome.storage.local.set(touchUpdates);
  }

  return {
    translations,
    hitCount
  };
}

export async function setCachedTranslations(
  settings: ExtensionSettings,
  entries: Array<{ text: string; translation: string }>,
  now = Date.now()
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const keys = await Promise.all(
    entries.map((entry) => buildTranslationCacheKey(settings, entry.text))
  );
  const storageEntries: Record<string, TranslationCacheEntry> = {};

  entries.forEach((entry, index) => {
    storageEntries[keys[index]] = {
      translation: entry.translation,
      createdAt: now,
      lastUsedAt: now
    };
  });

  await chrome.storage.local.set(storageEntries);
  await pruneTranslationCache(now);
}

export async function pruneTranslationCache(now = Date.now()): Promise<void> {
  if (now - lastPrunedAt < CACHE_PRUNE_INTERVAL_MS) {
    return;
  }

  lastPrunedAt = now;
  const stored = await chrome.storage.local.get(null);
  const cacheEntries = Object.entries(stored).filter(([key]) =>
    key.startsWith(TRANSLATION_CACHE_PREFIX)
  );
  const removableKeys: string[] = [];
  const validEntries: Array<[string, TranslationCacheEntry]> = [];

  for (const [key, value] of cacheEntries) {
    if (!isTranslationCacheEntry(value)) {
      removableKeys.push(key);
      continue;
    }

    if (now - value.createdAt > TRANSLATION_CACHE_TTL_MS) {
      removableKeys.push(key);
      continue;
    }

    validEntries.push([key, value]);
  }

  if (validEntries.length > TRANSLATION_CACHE_MAX_ENTRIES) {
    const overflowCount = validEntries.length - TRANSLATION_CACHE_MAX_ENTRIES;
    const overflowEntries = validEntries
      .sort((left, right) => {
        if (left[1].lastUsedAt !== right[1].lastUsedAt) {
          return left[1].lastUsedAt - right[1].lastUsedAt;
        }

        return left[1].createdAt - right[1].createdAt;
      })
      .slice(0, overflowCount);

    removableKeys.push(...overflowEntries.map(([key]) => key));
  }

  if (removableKeys.length > 0) {
    await chrome.storage.local.remove(removableKeys);
  }
}
