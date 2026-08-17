import { useEffect, useRef } from 'react';
import { createAurora } from '../../animations/aurora';
import type { AuroraHandle } from '../../animations/aurora';

/** Blob colours are drawn from the system palette so the background and the
 *  accents are provably the same family of hues. */
const BLOBS = [
  { color: '#0a84ff', size: 62, top: '12%', left: '18%' },
  { color: '#bf5af2', size: 54, top: '30%', left: '82%' },
  { color: '#ff375f', size: 48, top: '68%', left: '22%' },
  { color: '#40c8e0', size: 58, top: '84%', left: '76%' },
  { color: '#ffd60a', size: 34, top: '52%', left: '50%' },
];

/**
 * The animated background. `energy` is driven by the live mic level, so the
 * whole screen brightens and quickens while the user is speaking — the app
 * responds to the voice before any text has come back from the server.
 */
export function Aurora({ energy = 0 }: { energy?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<AuroraHandle | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    handleRef.current = createAurora(containerRef.current);
    return () => handleRef.current?.kill();
  }, []);

  useEffect(() => {
    handleRef.current?.setEnergy(energy);
  }, [energy]);

  return (
    <div className="aurora" ref={containerRef} aria-hidden="true">
      {BLOBS.map((blob, i) => (
        <div
          key={i}
          className="aurora__blob"
          style={{
            width: `${blob.size}vmax`,
            height: `${blob.size}vmax`,
            top: blob.top,
            left: blob.left,
            background: `radial-gradient(circle at 35% 35%, ${blob.color}, ${blob.color}00 70%)`,
          }}
        />
      ))}
      <div className="aurora__grain" />
    </div>
  );
}
