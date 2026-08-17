import { useCallback, useRef } from 'react';
import { spinSwapButton, swapLanguages } from '../../animations/interactions';
import type { LanguageOption } from '../../types';

export interface LanguageBarProps {
  languages: LanguageOption[];
  source: string;
  target: string;
  onPick: (role: 'source' | 'target') => void;
  onSwap: () => void;
  disabled?: boolean;
}

/**
 * Source ⇄ target selector.
 *
 * The two chips are laid out with `flex-direction` reversed on swap so FLIP has
 * a genuine geometry change to animate. Language names carry their own script
 * ("العربية", not "Arabic") because the person choosing a source language is by
 * definition someone who may not read the interface language.
 */
export function LanguageBar({ languages, source, target, onPick, onSwap, disabled }: LanguageBarProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const swapRef = useRef<HTMLButtonElement>(null);

  const sourceLang = languages.find((l) => l.speechCode === source);
  const targetLang = languages.find((l) => l.speechCode === target);

  const handleSwap = useCallback(() => {
    if (disabled) return;
    if (swapRef.current) spinSwapButton(swapRef.current);
    if (containerRef.current) {
      swapLanguages(containerRef.current, onSwap);
    } else {
      onSwap();
    }
  }, [disabled, onSwap]);

  return (
    <div className="langbar" ref={containerRef} data-intro>
      <button
        type="button"
        className="langbar__chip langbar__chip--source"
        data-flip-id="source"
        data-testid="source-chip"
        onClick={() => onPick('source')}
        disabled={disabled}
        aria-label={`Source language: ${sourceLang?.labelEn ?? source}. Change it.`}
      >
        <span className="langbar__flag" aria-hidden="true">
          {sourceLang?.flag ?? '🌐'}
        </span>
        <span className="langbar__labels">
          <span className="langbar__role">Speaking</span>
          {/* See LanguageSheet: a lone language name needs `lang` for the font,
              not `dir` — forcing RTL here would push the name to the far edge
              of the chip, away from its "Speaking" label. */}
          <span className="langbar__name" lang={sourceLang?.translateCode}>
            {sourceLang?.labelNative ?? source}
          </span>
        </span>
      </button>

      <button
        ref={swapRef}
        type="button"
        className="langbar__swap"
        data-testid="swap-languages"
        onClick={handleSwap}
        disabled={disabled}
        aria-label="Swap languages"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M7 4v13M7 17l-3.2-3.2M7 17l3.2-3.2M17 20V7M17 7l3.2 3.2M17 7l-3.2 3.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <button
        type="button"
        className="langbar__chip langbar__chip--target"
        data-flip-id="target"
        data-testid="target-chip"
        onClick={() => onPick('target')}
        disabled={disabled}
        aria-label={`Target language: ${targetLang?.labelEn ?? target}. Change it.`}
      >
        <span className="langbar__flag" aria-hidden="true">
          {targetLang?.flag ?? '🌐'}
        </span>
        <span className="langbar__labels">
          <span className="langbar__role">Hearing</span>
          <span className="langbar__name" lang={targetLang?.translateCode}>
            {targetLang?.labelNative ?? target}
          </span>
        </span>
      </button>
    </div>
  );
}
