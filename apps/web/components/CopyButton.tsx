'use client';

import { useState } from 'react';

export function CopyButton({ text, label, primary = false }: { text: string; label: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          window.prompt('Copy this link:', text);
        }
      }}
      className={
        primary
          ? 'inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover'
          : 'inline-flex h-9 items-center rounded-md border border-line bg-surface-3 px-3.5 text-sm font-medium transition-colors hover:bg-line-strong'
      }
    >
      {copied ? 'Copied!' : label}
    </button>
  );
}
