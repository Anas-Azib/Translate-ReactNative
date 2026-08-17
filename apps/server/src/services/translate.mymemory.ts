import type { TranslateProvider, TranslateResult } from '../types/index.js';
import { PipelineError, classifyMyMemoryFailure, classifyNetworkError } from '../lib/errors.js';

/**
 * Translation via MyMemory.
 *
 *   GET https://api.mymemory.translated.net/get?q=Hello&langpair=en|ar
 *   → { "responseStatus": 200, "responseData": { "translatedText": "..." } }
 *
 * Free, no API key. Two properties of this API drive the code below and were
 * confirmed against the live service:
 *
 *  1. **Failures arrive as HTTP 200.** The real status is `responseStatus`
 *     inside the body. Checking `response.ok` alone reports every error as a
 *     success.
 *  2. **The error message is delivered in the translation field.** A query over
 *     the length limit comes back with `translatedText` set to
 *     "QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS". Read
 *     naively, the app would show that to the user and read it aloud as their
 *     translation.
 */

/** MyMemory's hard cap on the `q` parameter. Confirmed against the live API. */
export const MYMEMORY_MAX_QUERY_CHARS = 500;

const DEFAULT_ENDPOINT = 'https://api.mymemory.translated.net/get';

export interface MyMemoryOptions {
  endpoint?: string;
  /**
   * Contact address sent as `de=`. MyMemory raises the anonymous daily
   * allowance from ~5,000 to ~50,000 characters when one is supplied.
   */
  email?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface MyMemoryBody {
  responseStatus?: number | string;
  responseDetails?: string;
  quotaFinished?: boolean;
  responseData?: { translatedText?: string; match?: number };
  matches?: Array<{ translation?: string; quality?: number | string; match?: number }>;
}

export class MyMemoryTranslateProvider implements TranslateProvider {
  readonly name = 'mymemory-translate' as const;
  readonly mode = 'real' as const;

  readonly #endpoint: string;
  readonly #email: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: MyMemoryOptions = {}) {
    this.#endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.#email = options.email || undefined;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async translate(input: {
    text: string;
    sourceLang: string;
    targetLang: string;
  }): Promise<TranslateResult> {
    // MyMemory rejects an identical pair with 403 "PLEASE SELECT TWO DISTINCT
    // LANGUAGES", so short-circuit rather than spend a request on a no-op.
    if (input.sourceLang === input.targetLang) {
      return { text: input.text, detectedSourceLang: input.sourceLang, billedChars: 0 };
    }

    if (input.text.length > MYMEMORY_MAX_QUERY_CHARS) {
      throw new PipelineError(
        'bad_request',
        this.name,
        `query exceeds MyMemory's ${MYMEMORY_MAX_QUERY_CHARS}-character limit`,
      );
    }

    const url = new URL(this.#endpoint);
    url.searchParams.set('q', input.text);
    url.searchParams.set('langpair', `${input.sourceLang}|${input.targetLang}`);
    if (this.#email) url.searchParams.set('de', this.#email);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      throw new PipelineError(classifyNetworkError(err), this.name, 'request failed');
    } finally {
      clearTimeout(timer);
    }

    const body = (await safeJson(response)) as MyMemoryBody | null;

    const failure = classifyMyMemoryFailure(response.status, body);
    if (failure) {
      throw new PipelineError(failure, this.name, truncate(body?.responseDetails) ?? `HTTP ${response.status}`);
    }

    const translated = body?.responseData?.translatedText;
    if (!translated) {
      throw new PipelineError('unknown', this.name, 'empty translation payload');
    }

    return {
      text: normalizeText(decodeEntities(translated)),
      detectedSourceLang: input.sourceLang,
      billedChars: input.text.length,
      // MyMemory is a translation *memory*: a low match score means it fell back
      // to a loose fuzzy hit rather than a real translation, which the UI can
      // flag rather than presenting it with false confidence.
      matchQuality: normalizeMatch(body?.responseData?.match),
    };
  }
}

/**
 * Offline translation for tests and for running without network access.
 */
export class MockTranslateProvider implements TranslateProvider {
  readonly name = 'mymemory-translate' as const;
  readonly mode = 'mock' as const;

  static readonly PHRASEBOOK: Record<string, Record<string, string>> = {
    'مرحبا، كيف حالك؟': {
      en: 'Hello, how are you?',
      fr: 'Bonjour, comment allez-vous ?',
      es: 'Hola, ¿cómo estás?',
      de: 'Hallo, wie geht es dir?',
      tr: 'Merhaba, nasılsın?',
    },
    'أين أقرب مستشفى؟': {
      en: 'Where is the nearest hospital?',
      fr: "Où est l'hôpital le plus proche ?",
      es: '¿Dónde está el hospital más cercano?',
      de: 'Wo ist das nächste Krankenhaus?',
      tr: 'En yakın hastane nerede?',
    },
    'أحتاج إلى مساعدة من فضلك': {
      en: 'I need some help please',
      fr: "J'ai besoin d'aide s'il vous plaît",
      es: 'Necesito ayuda por favor',
      de: 'Ich brauche bitte Hilfe',
      tr: 'Lütfen yardıma ihtiyacım var',
    },
    'كم يكلف هذا؟': {
      en: 'How much does this cost?',
      fr: 'Combien ça coûte ?',
      es: '¿Cuánto cuesta esto?',
      de: 'Wie viel kostet das?',
      tr: 'Bu ne kadar?',
    },
    'شكرا جزيلا لك': {
      en: 'Thank you very much',
      fr: 'Merci beaucoup',
      es: 'Muchas gracias',
      de: 'Vielen Dank',
      tr: 'Çok teşekkür ederim',
    },
    'Hello, how are you?': {
      ar: 'مرحبا، كيف حالك؟',
      fr: 'Bonjour, comment allez-vous ?',
      es: 'Hola, ¿cómo estás?',
    },
    'Where is the nearest hospital?': {
      ar: 'أين أقرب مستشفى؟',
      fr: "Où est l'hôpital le plus proche ?",
    },
    'I need some help please': { ar: 'أحتاج إلى مساعدة من فضلك', fr: "J'ai besoin d'aide s'il vous plaît" },
    'How much does this cost?': { ar: 'كم يكلف هذا؟', fr: 'Combien ça coûte ?' },
    'Thank you very much': { ar: 'شكرا جزيلا لك', fr: 'Merci beaucoup' },
  };

  async translate(input: {
    text: string;
    sourceLang: string;
    targetLang: string;
  }): Promise<TranslateResult> {
    if (input.sourceLang === input.targetLang) {
      return { text: input.text, detectedSourceLang: input.sourceLang, billedChars: 0 };
    }
    const known = MockTranslateProvider.PHRASEBOOK[input.text.trim()]?.[input.targetLang];
    return {
      text: known ?? `[${input.targetLang}] ${input.text}`,
      detectedSourceLang: input.sourceLang,
      billedChars: input.text.length,
      matchQuality: known ? 1 : 0.5,
    };
  }
}

/** MyMemory returns HTML-escaped text. */
export function decodeEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Normalises the returned text to standard Unicode.
 *
 * Some MyMemory translation-memory entries come back in the Arabic
 * **Presentation Forms** blocks (U+FB50–U+FEFF) rather than standard Arabic
 * letters — a real response for "hello" was `U+FEFC U+FEEB U+FE8D`. Those
 * codepoints are pre-shaped glyph variants: they render with broken joining in
 * most fonts, break copy-paste and search, and — now that the browser speaks
 * the translation — are mispronounced or skipped entirely by speech synthesis.
 *
 * NFKC maps them back to the ordinary letters. It leaves correctly-encoded
 * Arabic and all Latin text byte-for-byte identical, so it is safe to apply to
 * every response.
 *
 * Note this fixes the *encoding*, not the translation: a poor fuzzy match is
 * still a poor match, which is what `matchQuality` is for.
 */
export function normalizeText(input: string): string {
  return input.normalize('NFKC');
}

function normalizeMatch(match: unknown): number | undefined {
  if (typeof match !== 'number' || Number.isNaN(match)) return undefined;
  return Math.min(1, Math.max(0, match));
}

function truncate(value?: string): string | undefined {
  if (!value) return undefined;
  return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
