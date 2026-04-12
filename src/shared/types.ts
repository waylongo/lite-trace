export type ProviderKind = "google" | "openai";

export interface GoogleSettings {
  apiKey: string;
}

export interface OpenAISettings {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface PreferencesSettings {
  targetLang: "zh-CN";
  selectionUi: "auto-popup";
  pageScope: "static-content";
  hasCompletedSetup: boolean;
  hasSeenReadingCoachmark: boolean;
}

export interface ExtensionSettings {
  activeProvider: ProviderKind;
  google: GoogleSettings;
  openai: OpenAISettings;
  preferences: PreferencesSettings;
}

export interface TranslationError {
  code:
    | "CONFIG_MISSING"
    | "PERMISSION_DENIED"
    | "NETWORK_ERROR"
    | "PROVIDER_ERROR"
    | "PARSE_ERROR"
    | "UNKNOWN_ERROR";
  message: string;
  action?: "open-options";
}

export interface TranslationMeta {
  cacheHits: number;
  requestedCount: number;
  networkCount: number;
}

export interface TranslationSuccess {
  ok: true;
  translations: string[];
  meta?: TranslationMeta;
}

export interface TranslationFailure {
  ok: false;
  error: TranslationError;
}

export type TranslationResponse = TranslationSuccess | TranslationFailure;

export interface TranslationRequestPayload {
  texts: string[];
  settingsOverride?: ExtensionSettings;
}

export interface ExtensionStatus {
  configured: boolean;
  providerLabel: string;
  hasCompletedSetup: boolean;
  activeTabSupported: boolean;
  activeTabImmersiveActive: boolean;
}

export interface ReadingCoachmarkStatus {
  shouldShow: boolean;
}

export type RuntimeMessage =
  | { type: "TOGGLE_IMMERSIVE_TRANSLATION" }
  | { type: "GET_PAGE_IMMERSIVE_STATE" }
  | { type: "TRANSLATE_PAGE_BLOCKS"; payload: TranslationRequestPayload }
  | { type: "TRANSLATE_SELECTION"; payload: TranslationRequestPayload }
  | { type: "OPEN_OPTIONS" }
  | { type: "GET_EXTENSION_STATUS" }
  | { type: "TRIGGER_ACTIVE_TAB_IMMERSIVE" }
  | { type: "GET_READING_COACHMARK_STATUS" }
  | { type: "MARK_READING_COACHMARK_SEEN" };

export interface TranslatableBlock {
  element: HTMLElement;
  text: string;
}

export interface GroupedTranslatableBlocks {
  text: string;
  blockIndexes: number[];
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  activeProvider: "google",
  google: {
    apiKey: ""
  },
  openai: {
    baseUrl: "",
    model: "",
    apiKey: ""
  },
  preferences: {
    targetLang: "zh-CN",
    selectionUi: "auto-popup",
    pageScope: "static-content",
    hasCompletedSetup: false,
    hasSeenReadingCoachmark: false
  }
};
