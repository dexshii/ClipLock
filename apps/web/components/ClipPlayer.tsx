'use client';

import { useRef, useState } from 'react';
import type { Rendition } from '@cliplock/shared';

/** HTML5 player with a quality picker when several renditions exist. */
export function ClipPlayer({ renditions, poster, title, autoPlay = false }: { renditions: Rendition[]; poster: string; title: string; autoPlay?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [current, setCurrent] = useState(0);
  const source = renditions[current];

  const switchTo = (index: number) => {
    const v = ref.current;
    const time = v?.currentTime ?? 0;
    const playing = v ? !v.paused : false;
    setCurrent(index);
    requestAnimationFrame(() => {
      if (!ref.current) return;
      ref.current.currentTime = time;
      if (playing) void ref.current.play();
    });
  };

  return (
    <div className="relative">
      <video
        ref={ref}
        key={source?.url}
        src={source?.url}
        poster={poster}
        controls
        playsInline
        autoPlay={autoPlay}
        preload="metadata"
        aria-label={title}
        className="aspect-video w-full bg-black"
      />
      {renditions.length > 1 && (
        <select
          aria-label="Quality"
          value={current}
          onChange={(e) => switchTo(Number(e.target.value))}
          className="absolute right-3 top-3 rounded-md border border-white/10 bg-black/70 px-2 py-1 text-xs text-white backdrop-blur"
        >
          {renditions.map((r, i) => (
            <option key={r.url} value={i}>
              {r.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
