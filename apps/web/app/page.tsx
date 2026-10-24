import { Header } from '@/components/Header';

const FEATURES = [
  ['Instant Replay', 'A rolling buffer of your last 15 seconds to 5 minutes. Press Alt+F10 after the play happens.'],
  ['Hardware encoding', 'NVIDIA NVENC, AMD AMF and Intel Quick Sync with an automatic software fallback.'],
  ['Clip library & editor', 'Search, favorite, trim, change speed and volume, and export without leaving the app.'],
  ['Share anywhere', 'Upload to your own ClipLock server and paste one link into Discord or any chat.'],
  ['Private by default', 'Microphone off, no telemetry, nothing uploaded unless you choose to.'],
  ['Open source', 'MIT licensed. Run the whole platform on your own hardware and storage.'],
];

export default function Home() {
  return (
    <>
      <Header />
      <main>
        <section className="mx-auto max-w-6xl px-4 pb-16 pt-20 sm:px-6">
          <p className="text-sm font-medium text-accent">Open-source gaming clip recorder for Windows</p>
          <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">Capture it. Keep it.</h1>
          <p className="mt-4 max-w-xl text-lg text-fg-muted">
            ClipLock records your best moments with minimal overhead, keeps them organized on your PC, and shares them with a link.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="https://github.com/dexshii/ClipLock/releases" className="inline-flex h-11 items-center rounded-md bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover">
              Download for Windows
            </a>
            <a href="https://github.com/dexshii/ClipLock" className="inline-flex h-11 items-center rounded-md border border-line bg-surface-3 px-5 text-sm font-medium hover:bg-line-strong">
              View source
            </a>
          </div>
        </section>
        <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-24 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
          {FEATURES.map(([title, body]) => (
            <div key={title} className="rounded-lg border border-line bg-surface p-5">
              <h2 className="text-sm font-semibold">{title}</h2>
              <p className="mt-1.5 text-sm text-fg-muted">{body}</p>
            </div>
          ))}
        </section>
      </main>
    </>
  );
}
