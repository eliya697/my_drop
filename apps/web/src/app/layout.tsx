import type { Metadata, Viewport } from "next";
import { Heebo } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import { publicEnv } from "@/lib/public-env";
import "./globals.css";

const heebo = Heebo({
  subsets: ["hebrew", "latin"],
  display: "swap",
  variable: "--font-heebo",
});

const SITE_NAME = "החנות";

export const metadata: Metadata = {
  metadataBase: new URL(publicEnv.NEXT_PUBLIC_SITE_URL),
  title: { default: SITE_NAME, template: `%s | ${SITE_NAME}` },
  description: "מוצרים נבחרים במשלוח עד הבית",
  openGraph: { type: "website", locale: "he_IL", siteName: SITE_NAME },
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#16171d" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="he" dir="rtl" className={heebo.variable}>
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:start-2 focus:z-50 focus:rounded-md focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-white"
        >
          דילוג לתוכן הראשי
        </a>
        <div className="flex min-h-dvh flex-col">
          <header className="border-b border-[var(--border)]">
            <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
              <Link href="/" className="text-xl font-bold tracking-tight">
                {SITE_NAME}
              </Link>
              <nav aria-label="ניווט ראשי" className="flex gap-6 text-sm text-[var(--muted)]">
                <Link href="/" className="hover:text-[var(--foreground)]">
                  דף הבית
                </Link>
              </nav>
            </div>
          </header>
          <main id="main" className="flex-1">
            {children}
          </main>
          <footer className="border-t border-[var(--border)] py-8 text-center text-sm text-[var(--muted)]">
            © <bdi>{new Date().getFullYear()}</bdi> {SITE_NAME}. כל הזכויות שמורות.
          </footer>
        </div>
      </body>
    </html>
  );
}
