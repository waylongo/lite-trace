import { normalizeOpenAIBaseUrl } from "./settings";
import { normalizeTranslationText } from "./translation-runtime";
import { createGlossaryFingerprint } from "./glossary";
import type { ExtensionSettings, GlossaryTerm } from "./types";

export const TRANSLATION_CACHE_PREFIX = "litetrace.cache.entry.";
export const TRANSLATION_CACHE_INDEX_KEY = "litetrace.cache.index";
export const TRANSLATION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TRANSLATION_CACHE_MAX_ENTRIES = 2_000;

const CACHE_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const CACHE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const TRANSLATION_CACHE_INDEX_VERSION = 1;

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

interface TranslationCacheIndexEntry {
  createdAt: number;
  lastUsedAt: number;
}

interface TranslationCacheIndex {
  version: number;
  entries: Record<string, TranslationCacheIndexEntry>;
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

function isTranslationCacheIndexEntry(
  value: unknown
): value is TranslationCacheIndexEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<TranslationCacheIndexEntry>;
  return (
    typeof candidate.createdAt === "number" &&
    typeof candidate.lastUsedAt === "number"
  );
}

function isTranslationCacheIndex(value: unknown): value is TranslationCacheIndex {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<TranslationCacheIndex>;

  if (
    candidate.version !== TRANSLATION_CACHE_INDEX_VERSION ||
    !candidate.entries ||
    typeof candidate.entries !== "object"
  ) {
    return false;
  }

  return Object.values(candidate.entries).every((entry) =>
    isTranslationCacheIndexEntry(entry)
  );
}

function createEmptyCacheIndex(): TranslationCacheIndex {
  return {
    version: TRANSLATION_CACHE_INDEX_VERSION,
    entries: {}
  };
}

function cloneCacheIndex(index: TranslationCacheIndex): TranslationCacheIndex {
  return {
    version: index.version,
    entries: Object.fromEntries(
      Object.entries(index.entries).map(([key, entry]) => [
        key,
        {
          createdAt: entry.createdAt,
          lastUsedAt: entry.lastUsedAt
        }
      ])
    )
  };
}

async function readTranslationCacheIndex(): Promise<TranslationCacheIndex | null> {
  const stored = await chrome.storage.local.get(TRANSLATION_CACHE_INDEX_KEY);
  const index = stored[TRANSLATION_CACHE_INDEX_KEY];
  return isTranslationCacheIndex(index) ? cloneCacheIndex(index) : null;
}

async function rebuildTranslationCacheIndex(
  now = Date.now()
): Promise<TranslationCacheIndex> {
  const stored = await chrome.storage.local.get(null);
  const index = createEmptyCacheIndex();
  const removableKeys: string[] = [];

  Object.entries(stored).forEach(([key, value]) => {
    if (!key.startsWith(TRANSLATION_CACHE_PREFIX)) {
      return;
    }

    if (!isTranslationCacheEntry(value)) {
      removableKeys.push(key);
      return;
    }

    if (now - value.createdAt > TRANSLATION_CACHE_TTL_MS) {
      removableKeys.push(key);
      return;
    }

    index.entries[key] = {
      createdAt: value.createdAt,
      lastUsedAt: value.lastUsedAt
    };
  });

  if (removableKeys.length > 0) {
    await chrome.storage.local.remove(removableKeys);
  }

  await chrome.storage.local.set({
    [TRANSLATION_CACHE_INDEX_KEY]: index
  });

  return index;
}

function createIdentityString(
  settings: ExtensionSettings,
  text: string,
  glossaryTerms: GlossaryTerm[] = []
): string {
  return [
    settings.activeProvider,
    settings.activeProvider === "google"
      ? "google-translate"
      : normalizeOpenAIBaseUrl(settings.openai.baseUrl),
    settings.activeProvider === "google" ? "" : settings.openai.model.trim(),
    settings.preferences.targetLang,
    settings.activeProvider === "openai"
      ? createGlossaryFingerprint(text, glossaryTerms)
      : "",
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
  text: string,
  glossaryTerms: GlossaryTerm[] = []
): Promise<string> {
  const hash = await sha256Hex(createIdentityString(settings, text, glossaryTerms));
  return `${TRANSLATION_CACHE_PREFIX}${hash}`;
}

export async function getCachedTranslations(
  settings: ExtensionSettings,
  texts: string[],
  now = Date.now(),
  glossaryTerms: GlossaryTerm[] = []
): Promise<CachedTranslationsResult> {
  if (texts.length === 0) {
    return {
      translations: [],
      hitCount: 0
    };
  }

  const keys = await Promise.all(
    texts.map((text) => buildTranslationCacheKey(settings, text, glossaryTerms))
  );
  const stored = await chrome.storage.local.get([
    TRANSLATION_CACHE_INDEX_KEY,
    ...keys
  ]);
  const existingIndex = isTranslationCacheIndex(stored[TRANSLATION_CACHE_INDEX_KEY])
    ? cloneCacheIndex(stored[TRANSLATION_CACHE_INDEX_KEY] as TranslationCacheIndex)
    : null;
  const nextIndex = existingIndex ? cloneCacheIndex(existingIndex) : createEmptyCacheIndex();
  const translations = new Array<string | null>(texts.length).fill(null);
  const touchUpdates: Record<string, TranslationCacheEntry> = {};
  const keysToRemove: string[] = [];
  let hitCount = 0;
  let shouldPersistIndex = false;

  keys.forEach((key, index) => {
    const entry = stored[key];

    if (!isTranslationCacheEntry(entry)) {
      if (entry !== undefined) {
        keysToRemove.push(key);
      }

      if (key in nextIndex.entries) {
        delete nextIndex.entries[key];
        shouldPersistIndex = true;
      }

      return;
    }

    if (now - entry.createdAt > TRANSLATION_CACHE_TTL_MS) {
      keysToRemove.push(key);

      if (key in nextIndex.entries) {
        delete nextIndex.entries[key];
        shouldPersistIndex = true;
      }

      return;
    }

    translations[index] = entry.translation;
    hitCount += 1;

    if (
      existingIndex &&
      (
        !(key in existingIndex.entries) ||
        existingIndex.entries[key].createdAt !== entry.createdAt ||
        existingIndex.entries[key].lastUsedAt !== entry.lastUsedAt
      )
    ) {
      nextIndex.entries[key] = {
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt
      };
      shouldPersistIndex = true;
    }

    if (now - entry.lastUsedAt >= CACHE_TOUCH_INTERVAL_MS) {
      touchUpdates[key] = {
        ...entry,
        lastUsedAt: now
      };

      nextIndex.entries[key] = {
        createdAt: entry.createdAt,
        lastUsedAt: now
      };
      shouldPersistIndex = true;
    }
  });

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }

  const updates: Record<string, unknown> = {};

  if (Object.keys(touchUpdates).length > 0) {
    Object.assign(updates, touchUpdates);
  }

  if (shouldPersistIndex) {
    updates[TRANSLATION_CACHE_INDEX_KEY] = nextIndex;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  return {
    translations,
    hitCount
  };
}

export async function setCachedTranslations(
  settings: ExtensionSettings,
  entries: Array<{ text: string; translation: string }>,
  now = Date.now(),
  glossaryTerms: GlossaryTerm[] = []
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const keys = await Promise.all(
    entries.map((entry) =>
      buildTranslationCacheKey(settings, entry.text, glossaryTerms)
    )
  );
  const existingIndex = await readTranslationCacheIndex();
  const nextIndex = existingIndex ? cloneCacheIndex(existingIndex) : createEmptyCacheIndex();
  const storageEntries: Record<string, TranslationCacheEntry> = {};

  entries.forEach((entry, index) => {
    storageEntries[keys[index]] = {
      translation: entry.translation,
      createdAt: now,
      lastUsedAt: now
    };

    nextIndex.entries[keys[index]] = {
      createdAt: now,
      lastUsedAt: now
    };
  });

  await chrome.storage.local.set({
    ...storageEntries,
    [TRANSLATION_CACHE_INDEX_KEY]: nextIndex
  });
  await pruneTranslationCache(now);
}

export async function pruneTranslationCache(now = Date.now()): Promise<void> {
  if (now - lastPrunedAt < CACHE_PRUNE_INTERVAL_MS) {
    return;
  }

  lastPrunedAt = now;
  const existingIndex = await readTranslationCacheIndex();
  const index = existingIndex ?? (await rebuildTranslationCacheIndex(now));
  const cacheKeys = Object.keys(index.entries);
  const stored = cacheKeys.length > 0
    ? await chrome.storage.local.get(cacheKeys)
    : {};
  const removableKeys: string[] = [];
  const validEntries: Array<[string, TranslationCacheEntry]> = [];
  let shouldPersistIndex = existingIndex === null;

  for (const key of cacheKeys) {
    const value = stored[key];

    if (!isTranslationCacheEntry(value)) {
      removableKeys.push(key);
      delete index.entries[key];
      shouldPersistIndex = true;
      continue;
    }

    if (now - value.createdAt > TRANSLATION_CACHE_TTL_MS) {
      removableKeys.push(key);
      delete index.entries[key];
      shouldPersistIndex = true;
      continue;
    }

    const storedIndexEntry = index.entries[key];
    if (
      storedIndexEntry.createdAt !== value.createdAt ||
      storedIndexEntry.lastUsedAt !== value.lastUsedAt
    ) {
      index.entries[key] = {
        createdAt: value.createdAt,
        lastUsedAt: value.lastUsedAt
      };
      shouldPersistIndex = true;
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

    overflowEntries.forEach(([key]) => {
      removableKeys.push(key);
      delete index.entries[key];
    });
    shouldPersistIndex = true;
  }

  if (removableKeys.length > 0) {
    await chrome.storage.local.remove(removableKeys);
  }

  if (shouldPersistIndex) {
    await chrome.storage.local.set({
      [TRANSLATION_CACHE_INDEX_KEY]: index
    });
  }
}
