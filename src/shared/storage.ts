import { DEFAULT_SETTINGS, type ExtensionSettings } from "./types";
import { mergeSettings } from "./settings";

const SETTINGS_KEY = "litetrace.settings";

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored[SETTINGS_KEY] ?? DEFAULT_SETTINGS);
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({
    [SETTINGS_KEY]: mergeSettings(settings)
  });
}
