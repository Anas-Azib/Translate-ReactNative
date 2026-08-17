import { describe, expect, it } from 'vitest';
import {
  EphemeralVault,
  deriveKey,
  hashToUnitInterval,
  open,
  safeCompare,
  seal,
  shred,
  stableHash,
} from '../../src/lib/crypto.js';
import { TtlCache } from '../../src/lib/cache.js';
import { FakeClock } from '../../src/lib/clock.js';

/**
 * Plan doc, p.3: "The data should be encrypted, temporarily processed, then
 * deleted." These tests hold that line.
 */
describe('EphemeralVault', () => {
  it('round-trips audio through encryption', () => {
    const vault = new EphemeralVault('test-secret');
    const original = Buffer.from('sensitive audio bytes');

    const handle = vault.store(Buffer.from(original));
    const recovered = vault.use(handle, (plaintext) => Buffer.from(plaintext));

    expect(recovered.equals(original)).toBe(true);
  });

  it('shreds the caller’s plaintext on store, so the buffer cannot linger', () => {
    const vault = new EphemeralVault('test-secret');
    const buffer = Buffer.from('secret payload');

    vault.store(buffer);

    expect(buffer.every((byte) => byte === 0)).toBe(true);
  });

  it('deletes the ciphertext on release', () => {
    const vault = new EphemeralVault('test-secret');
    const handle = vault.store(Buffer.from('data'));

    expect(vault.size).toBe(1);
    vault.release(handle);
    expect(vault.size).toBe(0);
    expect(() => vault.use(handle, (b) => b)).toThrow(/unknown or already-released/);
  });

  it('is idempotent on double release', () => {
    const vault = new EphemeralVault('s');
    const handle = vault.store(Buffer.from('data'));
    vault.release(handle);
    expect(() => vault.release(handle)).not.toThrow();
  });

  it('shreds the decrypted copy even when the consumer throws', () => {
    const vault = new EphemeralVault('s');
    const handle = vault.store(Buffer.from('data'));
    let captured: Buffer | null = null;

    expect(() =>
      vault.use(handle, (plaintext) => {
        captured = plaintext;
        throw new Error('processing blew up');
      }),
    ).toThrow('processing blew up');

    expect(captured!.every((byte: number) => byte === 0)).toBe(true);
  });

  it('gives every stored payload a distinct handle', () => {
    const vault = new EphemeralVault('s');
    const a = vault.store(Buffer.from('one'));
    const b = vault.store(Buffer.from('two'));
    expect(a).not.toBe(b);
  });

  it('clears everything on releaseAll', () => {
    const vault = new EphemeralVault('s');
    vault.store(Buffer.from('a'));
    vault.store(Buffer.from('b'));

    vault.releaseAll();

    expect(vault.size).toBe(0);
  });
});

describe('seal / open', () => {
  it('produces different ciphertext each time for identical input', () => {
    const key = deriveKey('secret');
    const a = seal(Buffer.from('same input'), key);
    const b = seal(Buffer.from('same input'), key);

    // A fresh IV per call is what stops an observer from spotting repeats.
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects tampered ciphertext via the auth tag', () => {
    const key = deriveKey('secret');
    const sealed = seal(Buffer.from('important'), key);
    sealed.ciphertext.writeUInt8(sealed.ciphertext.readUInt8(0) ^ 0xff, 0);

    expect(() => open(sealed, key)).toThrow();
  });

  it('cannot be opened with the wrong key', () => {
    const sealed = seal(Buffer.from('important'), deriveKey('key-a'));
    expect(() => open(sealed, deriveKey('key-b'))).toThrow();
  });
});

describe('deriveKey', () => {
  it('accepts a 64-char hex key verbatim', () => {
    expect(deriveKey('ab'.repeat(32))).toHaveLength(32);
  });

  it('hashes an arbitrary passphrase to 32 bytes', () => {
    expect(deriveKey('short')).toHaveLength(32);
  });

  it('generates a random key when none is provided', () => {
    expect(deriveKey('').equals(deriveKey(''))).toBe(false);
  });
});

describe('shred', () => {
  it('zeroes the buffer in place', () => {
    const buffer = Buffer.from([1, 2, 3, 4]);
    shred(buffer);
    expect([...buffer]).toEqual([0, 0, 0, 0]);
  });
});

describe('hashToUnitInterval', () => {
  it('always lands inside [0,1)', () => {
    for (let i = 0; i < 500; i += 1) {
      const value = hashToUnitInterval(`user-${i}`);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('is deterministic', () => {
    expect(hashToUnitInterval('same')).toBe(hashToUnitInterval('same'));
  });

  it('spreads roughly uniformly — the property A/B bucketing depends on', () => {
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10_000; i += 1) {
      buckets[Math.floor(hashToUnitInterval(`user-${i}`) * 10)] += 1;
    }
    // Each decile should hold ~1000; allow generous slack for hash noise.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1150);
    }
  });
});

describe('stableHash / safeCompare', () => {
  it('stableHash is deterministic and does not embed its input', () => {
    const hash = stableHash('device-id-12345', 'salt');

    expect(hash).toBe(stableHash('device-id-12345', 'salt'));
    expect(hash).not.toContain('device-id-12345');
    expect(hash).toHaveLength(64);
  });

  it('stableHash separates its parts, so ("ab","c") ≠ ("a","bc")', () => {
    expect(stableHash('ab', 'c')).not.toBe(stableHash('a', 'bc'));
  });

  it('safeCompare matches identical strings and rejects different lengths', () => {
    expect(safeCompare('token', 'token')).toBe(true);
    expect(safeCompare('token', 'tokens')).toBe(false);
    expect(safeCompare('token', 'nekot')).toBe(false);
  });
});

describe('TtlCache', () => {
  it('returns stored values and counts hits', () => {
    const cache = new TtlCache<string>();
    cache.set('k', 'v');

    expect(cache.get('k')).toBe('v');
    expect(cache.stats.hits).toBe(1);
  });

  it('expires entries after the TTL', () => {
    const clock = new FakeClock();
    const cache = new TtlCache<string>({ ttlMs: 1000, clock });
    cache.set('k', 'v');

    clock.advance(1001);

    expect(cache.get('k')).toBeUndefined();
  });

  it('evicts the least recently used entry when full', () => {
    const cache = new TtlCache<string>({ maxEntries: 2 });
    cache.set('a', '1');
    cache.set('b', '2');
    cache.get('a'); // 'a' is now the most recent
    cache.set('c', '3');

    expect(cache.get('a')).toBe('1');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('3');
  });

  it('reports a hit rate', () => {
    const cache = new TtlCache<string>();
    cache.set('k', 'v');
    cache.get('k');
    cache.get('missing');

    expect(cache.stats.hitRate).toBeCloseTo(0.5);
  });
});
