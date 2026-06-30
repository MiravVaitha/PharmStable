import Link from "next/link";

export default async function AuthCodeError({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-cream text-gray-900 p-4 text-center">
      <div className="max-w-md p-8 bg-white border border-gray-100 rounded-2xl shadow-sm space-y-6">
        <h1 className="text-3xl font-black text-red-600">Authentication Error</h1>
        <p className="text-gray-600">
          The confirmation link you followed may have expired or is invalid.
          Please try signing up again or contact support if the issue persists.
        </p>
        {reason && (
          <p className="text-xs text-gray-400 break-words">
            <span className="font-mono">{reason}</span>
          </p>
        )}
        <Link
          href="/signup"
          className="inline-block py-3 px-6 bg-brand hover:bg-brand-dark text-white rounded-xl font-bold transition-colors"
        >
          Back to Sign Up
        </Link>
      </div>
    </div>
  );
}
