import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AliExpress authorization",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

const CODE = /^[A-Za-z0-9_-]{8,200}$/;

/**
 * OAuth callback registered in the AliExpress app console. It only displays the one-time code
 * for the operator to paste into `pnpm aliexpress:connect --code …`; the exchange happens in the
 * CLI, which holds the app secret. The code is useless without that secret and expires in 30
 * minutes.
 */
export default async function AliExpressCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const code = typeof params.code === "string" && CODE.test(params.code) ? params.code : null;

  return (
    <section dir="ltr" className="mx-auto max-w-2xl px-4 py-16 text-left">
      <h1 className="text-2xl font-bold">AliExpress authorization</h1>
      {code ? (
        <>
          <p className="mt-4 text-[var(--muted)]">Run this in the project folder within 30 minutes:</p>
          <pre className="mt-4 overflow-x-auto rounded-md border border-[var(--border)] p-4 text-sm">
            <code>pnpm aliexpress:connect --code {code}</code>
          </pre>
        </>
      ) : (
        <p className="mt-4 text-[var(--muted)]">
          No authorization code was received. Start again with <code>pnpm aliexpress:connect</code>.
        </p>
      )}
    </section>
  );
}
