import { useEffect, useMemo, useRef, useState } from 'react';
import { dismissSheet, presentSheet } from '../../animations/interactions';
import type { LanguageOption } from '../../types';

export interface LanguageSheetProps {
  open: boolean;
  role: 'source' | 'target';
  languages: LanguageOption[];
  selected: string;
  /** The other role's language, marked so the user can't pick the same twice. */
  otherSelected: string;
  onSelect: (code: string) => void;
  onClose: () => void;
  behindRef?: React.RefObject<HTMLElement | null>;
}

/**
 * iOS-style bottom sheet for language selection.
 *
 * Search matches the English name, the native name, and the language code, so
 * a user can find their language by typing it in their own script — the one
 * input method they're guaranteed to have.
 */
export function LanguageSheet({
  open,
  role,
  languages,
  selected,
  otherSelected,
  onSelect,
  onClose,
  behindRef,
}: LanguageSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (!mounted || !sheetRef.current || !backdropRef.current) return;

    if (open) {
      setQuery('');
      presentSheet(sheetRef.current, backdropRef.current, behindRef?.current);
    } else {
      dismissSheet(sheetRef.current, backdropRef.current, behindRef?.current, () => setMounted(false));
    }
  }, [open, mounted, behindRef]);

  // Escape closes, and while the sheet is up the page behind must not scroll.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return languages;
    return languages.filter(
      (l) =>
        l.labelEn.toLowerCase().includes(q) ||
        l.labelNative.toLowerCase().includes(q) ||
        l.translateCode.includes(q) ||
        l.speechCode.toLowerCase().includes(q),
    );
  }, [languages, query]);

  if (!mounted) return null;

  return (
    <div className="sheet-root" role="dialog" aria-modal="true" aria-label={`Choose ${role} language`}>
      <div ref={backdropRef} className="sheet__backdrop" onClick={onClose} data-testid="sheet-backdrop" />

      <div ref={sheetRef} className="sheet glass" data-testid="language-sheet">
        <div className="sheet__grabber" aria-hidden="true" />

        <header className="sheet__header">
          <h2 className="sheet__title">
            {role === 'source' ? 'I am speaking' : 'Translate into'}
          </h2>
          <button type="button" className="sheet__close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </button>
        </header>

        <div className="sheet__search">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
            <circle cx="11" cy="11" r="6.4" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M16 16l4.2 4.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search languages"
            aria-label="Search languages"
            data-testid="language-search"
          />
        </div>

        <ul className="sheet__list">
          {filtered.map((language) => {
            const isSelected = language.speechCode === selected;
            const isOther = language.speechCode === otherSelected;
            return (
              <li key={language.speechCode} data-sheet-item>
                <button
                  type="button"
                  className="sheet__option"
                  data-selected={isSelected}
                  disabled={isOther}
                  onClick={() => onSelect(language.speechCode)}
                  aria-current={isSelected}
                >
                  <span className="sheet__option-flag" aria-hidden="true">
                    {language.flag}
                  </span>
                  <span className="sheet__option-text">
                    {/* No `dir` here on purpose. A bare language name is a
                        single Arabic run, which the bidi algorithm already
                        shapes and orders correctly inside an LTR list. Forcing
                        dir="rtl" would additionally right-align it, leaving the
                        native name at one edge of the row and its English label
                        at the other. `lang` still drives font selection. */}
                    <span className="sheet__option-native" lang={language.translateCode}>
                      {language.labelNative}
                    </span>
                    <span className="sheet__option-en">{language.labelEn}</span>
                  </span>
                  {isOther && <span className="sheet__option-hint">in use</span>}
                  {isSelected && (
                    <svg className="sheet__check" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                      <path
                        d="M5 12.5l4.6 4.6L19 7.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
          {filtered.length === 0 && <li className="sheet__empty">No languages match “{query}”.</li>}
        </ul>
      </div>
    </div>
  );
}
