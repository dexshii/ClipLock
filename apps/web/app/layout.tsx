import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000'),
  title: { default: 'ClipLock — Capture it. Keep it.', template: '%s · ClipLock' },
  description: 'Open-source gaming clip recorder with Instant Replay and self-hostable sharing.',
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = { themeColor: '#0b0c0e', colorScheme: 'dark' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
