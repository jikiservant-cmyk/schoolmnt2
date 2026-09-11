import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#f7f7f8] text-[#171719] p-4 text-center">
      <h2 className="text-2xl font-bold">404 - Page Not Found</h2>
      <p className="text-[#87878c] mt-2 text-sm">Could not find the requested page or route.</p>
      <Link 
        href="/dashboard" 
        className="mt-4 px-4 py-2 bg-[#007aff] text-white rounded-lg text-sm font-medium hover:bg-[#0062cc] transition"
      >
        Return to Dashboard
      </Link>
    </div>
  );
}
