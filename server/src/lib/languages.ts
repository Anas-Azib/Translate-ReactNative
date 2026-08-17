import type { LanguageOption } from '../types/index.js';

/**
 * Supported languages. Arabic is first and is the default source language —
 * the plan document's primary user is "a native arabic speaker that doesnt
 * speak English".
 *
 * `ttsVoice` always names a **Standard** voice: those are the ones covered by
 * Google's 4M-character free tier (plan doc p.3). Neural2/WaveNet voices bill
 * at ~4× and would blow the budget.
 */
export const LANGUAGES: readonly LanguageOption[] = [
  {
    speechCode: 'ar-SA',
    translateCode: 'ar',
    ttsCode: 'ar-XA',
    ttsVoice: 'ar-XA-Standard-A',
    labelEn: 'Arabic',
    labelNative: 'العربية',
    flag: '🇸🇦',
    rtl: true,
  },
  {
    speechCode: 'en-US',
    translateCode: 'en',
    ttsCode: 'en-US',
    ttsVoice: 'en-US-Standard-C',
    labelEn: 'English',
    labelNative: 'English',
    flag: '🇺🇸',
    rtl: false,
  },
  {
    speechCode: 'fr-FR',
    translateCode: 'fr',
    ttsCode: 'fr-FR',
    ttsVoice: 'fr-FR-Standard-A',
    labelEn: 'French',
    labelNative: 'Français',
    flag: '🇫🇷',
    rtl: false,
  },
  {
    speechCode: 'es-ES',
    translateCode: 'es',
    ttsCode: 'es-ES',
    ttsVoice: 'es-ES-Standard-A',
    labelEn: 'Spanish',
    labelNative: 'Español',
    flag: '🇪🇸',
    rtl: false,
  },
  {
    speechCode: 'de-DE',
    translateCode: 'de',
    ttsCode: 'de-DE',
    ttsVoice: 'de-DE-Standard-A',
    labelEn: 'German',
    labelNative: 'Deutsch',
    flag: '🇩🇪',
    rtl: false,
  },
  {
    speechCode: 'tr-TR',
    translateCode: 'tr',
    ttsCode: 'tr-TR',
    ttsVoice: 'tr-TR-Standard-A',
    labelEn: 'Turkish',
    labelNative: 'Türkçe',
    flag: '🇹🇷',
    rtl: false,
  },
  {
    speechCode: 'hi-IN',
    translateCode: 'hi',
    ttsCode: 'hi-IN',
    ttsVoice: 'hi-IN-Standard-A',
    labelEn: 'Hindi',
    labelNative: 'हिन्दी',
    flag: '🇮🇳',
    rtl: false,
  },
  {
    speechCode: 'ur-PK',
    translateCode: 'ur',
    ttsCode: 'ur-IN',
    ttsVoice: 'ur-IN-Standard-A',
    labelEn: 'Urdu',
    labelNative: 'اردو',
    flag: '🇵🇰',
    rtl: true,
  },
  {
    speechCode: 'zh-CN',
    translateCode: 'zh',
    ttsCode: 'cmn-CN',
    ttsVoice: 'cmn-CN-Standard-A',
    labelEn: 'Chinese',
    labelNative: '中文',
    flag: '🇨🇳',
    rtl: false,
  },
  {
    speechCode: 'ru-RU',
    translateCode: 'ru',
    ttsCode: 'ru-RU',
    ttsVoice: 'ru-RU-Standard-A',
    labelEn: 'Russian',
    labelNative: 'Русский',
    flag: '🇷🇺',
    rtl: false,
  },
  {
    speechCode: 'id-ID',
    translateCode: 'id',
    ttsCode: 'id-ID',
    ttsVoice: 'id-ID-Standard-A',
    labelEn: 'Indonesian',
    labelNative: 'Bahasa Indonesia',
    flag: '🇮🇩',
    rtl: false,
  },
  {
    speechCode: 'pt-BR',
    translateCode: 'pt',
    ttsCode: 'pt-BR',
    ttsVoice: 'pt-BR-Standard-A',
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
