import Link from 'next/link';

export function Header() {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" className="size-7" />
          <span className="text-sm font-semibold tracking-tight">ClipLock</span>
        </Link>
        <a href="https://github.com/dexshii/ClipLock" className="text-sm text-fg-muted transition-colors hover:text-fg">
          Get ClipLock
        </a>
      </div>
    </header>
  );
}
