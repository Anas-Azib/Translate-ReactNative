import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Layout regression guard.
 *
 * jsdom performs no layout, so a real flexbox bug cannot be caught by rendering
 * a component here. What *can* be asserted is the specific declaration that
 * prevents it — which is worth doing, because this particular bug is invisible
 * until a conversation grows past one card and then silently eats the text.
 *
 * The bug: `.stream` is a column flex container, so every card is a flex item.
 * Flex items default to `flex-shrink: 1`, so once their combined height exceeds
 * the container the browser compresses them all to fit instead of letting the
 * container scroll. Because each card sets `overflow: hidden`, the compressed
 * height clips the transcript away — measured at 232px of content rendered into
 * 138px of card. The container also stops being scrollable, so there is no way
 * to reach the hidden text.
 */
// Resolved from cwd, not `import.meta.url`: under the jsdom environment the
// module URL is an http:// address served by Vite, not a file path.
const css = readFileSync(resolve(process.cwd(), 'src/styles/components.css'), 'utf8');

/** Extracts a rule body by exact selector. */
function ruleFor(selector: string): string {
  const pattern = new RegExp(`(^|\\})\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm');
  const match = css.match(pattern);
  if (!match) throw new Error(`No rule found for ${selector}`);
  return match[2]!;
}

/** True when the rule pins the item's size against flex compression. */
function resistsShrinking(body: string): boolean {
  // Either `flex: 0 0 auto` (shorthand) or an explicit `flex-shrink: 0`.
  return /flex:\s*0\s+0\s+auto/.test(body) || /flex-shrink:\s*0/.test(body);
}

describe('conversation stream layout', () => {
  it('scrolls its overflow rather than shrinking items', () => {
    const stream = ruleFor('.stream');
    expect(stream).toMatch(/overflow-y:\s*auto/);
    expect(stream).toMatch(/flex-direction:\s*column/);
    // `min-height: 0` is what lets a nested flex item actually scroll.
    expect(stream).toMatch(/min-height:\s*0/);
  });

  it('keeps transcript cards at their natural height', () => {
    // Without this the card compresses and `overflow: hidden` clips the text.
    expect(resistsShrinking(ruleFor('.card'))).toBe(true);
  });

  it('keeps the live segment at its natural height', () => {
    expect(resistsShrinking(ruleFor('.card--live'))).toBe(true);
  });

  it('keeps the empty state at its natural height', () => {
    expect(resistsShrinking(ruleFor('.empty'))).toBe(true);
  });

  it('documents why the card clips its own overflow', () => {
    // The clipping is deliberate (rounded corners over a gradient wash); it is
    // only dangerous when combined with shrinking, which the rule above stops.
    expect(ruleFor('.card')).toMatch(/overflow:\s*hidden/);
  });
});
