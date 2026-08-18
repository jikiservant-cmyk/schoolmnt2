import Link from 'next/link';
export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-meridian-bg-1">
      <h2 className="text-2xl font-bold text-meridian-text-1">Not Found</h2>
      <p className="text-meridian-text-2 mt-2">Could not find requested resource</p>
      <Link href="/" className="mt-4 text-meridian-gold hover:underline">
        Return Home
      </Link>
    </div>
  );
}
