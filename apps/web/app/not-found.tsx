import Link from 'next/link';
import { Header } from '@/components/Header';

export default function NotFound() {
  return (
    <>
      <Header />
      <main className="mx-auto flex max-w-md flex-col items-center px-6 py-24 text-center">
        <h1 className="text-xl font-semibold">This clip isn’t available</h1>
        <p className="mt-2 text-sm text-fg-muted">It may have been deleted, made private, or is still processing. Check the link and try again in a moment.</p>
        <Link href="/" className="mt-6 text-sm text-accent hover:underline">
          Go to ClipLock
        </Link>
      </main>
    </>
  );
}
