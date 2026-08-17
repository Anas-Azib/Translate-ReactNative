import type { TranslateProvider, TranslateResult } from '../types/index.js';
import { PipelineError, classifyGoogleFailure, classifyNetworkError } from '../lib/errors.js';

/**
 * Google Cloud Translation (NMT).
 *
 * Plan doc, p.3: first 500k characters/month are free, and failures are handled
 * "the same as above" — i.e. the Azure table in `lib/errors.ts`.
 */
export class GoogleTranslateProvider implements TranslateProvider {
  readonly name = 'google-translate' as const;
  readonly mode = 'real' as const;

  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    if (!options.apiKey) throw new Error('GoogleTranslateProvider requires an API key');
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async translate(input: {
    text: string;
    sourceLang: string;
    targetLang: string;
  }): Promise<TranslateResult> {
    // No-op translations are free money burned; short-circuit before the call.
    if (input.sourceLang === input.targetLang) {
      return { text: input.text, detectedSourceLang: input.sourceLang, billedChars: 0 };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(this.#apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            q: input.text,
            source: input.sourceLang,
            target: input.targetLang,
            format: 'text',
            model: 'nmt',
          }),
          signal: controller.signal,
        },
      );
    } catch (err) {
      throw new PipelineError(classifyNetworkError(err), this.name, 'request failed');
    } finally {
      clearTimeout(timer);
    }

    const body = await safeJson(response);
    if (!response.ok) {
      throw new PipelineError(classifyGoogleFailure(response.status, body), this.name, `HTTP ${response.status}`);
    }

    const translated = body?.data?.translations?.[0];
    if (!translated?.translatedText) {
      throw new PipelineError('unknown', this.name, 'empty translation payload');
    }

    return {
      text: decodeEntities(translated.translatedText),
      detectedSourceLang: translated.detectedSourceLanguage ?? input.sourceLang,
      // Google bills by source characters submitted.
      billedChars: input.text.length,
    };
  }
}

/**
 * Offline translation for tests and the no-key demo build. Uses a small phrase
 * book for the canned utterances, and a reversible marker otherwise so tests can
 * assert that translation actually happened.
 */
export class MockTranslateProvider implements TranslateProvider {
  readonly name = 'google-translate' as const;
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
    };
  }
}

/** Google returns HTML-escaped text even with format:"text". */
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

async function safeJson(response: Response): Promise<any | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
