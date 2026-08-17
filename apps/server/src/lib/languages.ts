import type { LanguageOption } from '../types/index.js';

/**
 * Supported languages. Arabic is first and is the default source language —
 * the plan document's primary user is "a native arabic speaker that doesnt
 * speak English".
 *
 * Two codes per language, each doing double duty:
 *  - `speechCode` (BCP-47) identifies the language in the UI and selects a
 *    voice from the browser's `speechSynthesis` engine.
 *  - `translateCode` (ISO-639-1) is MyMemory's `langpair` half and also
 *    Whisper's `language` hint, which accepts ISO codes.
 */
export const LANGUAGES: readonly LanguageOption[] = [
  {
    speechCode: 'ar-SA',
    translateCode: 'ar',
    labelEn: 'Arabic',
    labelNative: 'العربية',
    flag: '🇸🇦',
    rtl: true,
  },
  {
    speechCode: 'en-US',
    translateCode: 'en',
    labelEn: 'English',
    labelNative: 'English',
    flag: '🇺🇸',
    rtl: false,
  },
  {
    speechCode: 'fr-FR',
    translateCode: 'fr',
    labelEn: 'French',
    labelNative: 'Français',
    flag: '🇫🇷',
    rtl: false,
  },
  {
    speechCode: 'es-ES',
    translateCode: 'es',
    labelEn: 'Spanish',
    labelNative: 'Español',
    flag: '🇪🇸',
    rtl: false,
  },
  {
    speechCode: 'de-DE',
    translateCode: 'de',
    labelEn: 'German',
    labelNative: 'Deutsch',
    flag: '🇩🇪',
    rtl: false,
  },
  {
    speechCode: 'tr-TR',
    translateCode: 'tr',
    labelEn: 'Turkish',
    labelNative: 'Türkçe',
    flag: '🇹🇷',
    rtl: false,
  },
  {
    speechCode: 'hi-IN',
    translateCode: 'hi',
    labelEn: 'Hindi',
    labelNative: 'हिन्दी',
    flag: '🇮🇳',
    rtl: false,
  },
  {
    speechCode: 'ur-PK',
    translateCode: 'ur',
    labelEn: 'Urdu',
    labelNative: 'اردو',
    flag: '🇵🇰',
    rtl: true,
  },
  {
    speechCode: 'zh-CN',
    translateCode: 'zh',
    labelEn: 'Chinese',
    labelNative: '中文',
    flag: '🇨🇳',
    rtl: false,
  },
  {
    speechCode: 'ru-RU',
    translateCode: 'ru',
    labelEn: 'Russian',
    labelNative: 'Русский',
    flag: '🇷🇺',
    rtl: false,
  },
  {
    speechCode: 'id-ID',
    translateCode: 'id',
    labelEn: 'Indonesian',
    labelNative: 'Bahasa Indonesia',
    flag: '🇮🇩',
    rtl: false,
  },
  {
    speechCode: 'pt-BR',
    translateCode: 'pt',
    labelEn: 'Portuguese',
    labelNative: 'Português',
    flag: '🇧🇷',
    rtl: false,
  },
];

const BY_SPEECH_CODE = new Map(LANGUAGES.map((l) => [l.speechCode, l]));
const BY_TRANSLATE_CODE = new Map(LANGUAGES.map((l) => [l.translateCode, l]));

export function findLanguage(code: string): LanguageOption | undefined {
  return BY_SPEECH_CODE.get(code) ?? BY_TRANSLATE_CODE.get(code) ?? BY_TRANSLATE_CODE.get(code.split('-')[0] ?? '');
}

export function isSupported(code: string): boolean {
  return findLanguage(code) !== undefined;
}

export const DEFAULT_SOURCE = 'ar-SA';
export const DEFAULT_TARGET = 'en-US';
