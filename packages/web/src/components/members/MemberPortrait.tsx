import { useState } from 'react';
import { initials, portraitUrl } from '../../lib/members.js';

interface Props {
  politicianId: string;
  name: string;
  size?: 'sm' | 'md';
  muted?: boolean;
}

/** Official portrait, falling back to initials when there is none or it fails to load. */
export function MemberPortrait({ politicianId, name, size = 'md', muted = false }: Props) {
  const [failed, setFailed] = useState(false);
  const dims = size === 'sm' ? 'h-12 w-10 text-sm' : 'h-[72px] w-[60px] text-base';

  return (
    <div
      className={`${dims} relative shrink-0 overflow-hidden rounded-lg border border-rule bg-cantsay-wash ${muted ? 'opacity-60 grayscale' : ''}`}
    >
      {/* Initials sit underneath, so a slow or missing portrait is never an empty box. */}
      <div className="flex h-full w-full items-center justify-center font-serif text-ink-soft" aria-hidden="true">
        {initials(name)}
      </div>
      {failed ? null : (
        <img
          src={portraitUrl(politicianId)}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
