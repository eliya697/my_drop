import Link from "next/link";

export default function NotFound() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-24 text-center">
      <p className="text-sm font-semibold text-brand-600">
        <bdi>404</bdi>
      </p>
      <h1 className="mt-2 text-3xl font-bold">הדף לא נמצא</h1>
      <p className="mt-4 text-[var(--muted)]">ייתכן שהקישור שגוי או שהדף הוסר.</p>
      <Link
        href="/"
        className="mt-8 inline-block rounded-md bg-brand-600 px-5 py-2.5 text-white hover:bg-brand-700"
      >
        חזרה לדף הבית
      </Link>
    </section>
  );
}
