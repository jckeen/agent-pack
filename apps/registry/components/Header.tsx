import Link from "next/link";

const NAV = [
  { href: "/packs", label: "Packs" },
  { href: "/validate", label: "Validate" },
  { href: "/docs", label: "Docs" },
];

export function Header() {
  return (
    <header className="border-b border-ink-100 bg-white/70 backdrop-blur-sm">
      <div className="container-page flex h-16 items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-7 w-7 rounded-md bg-linear-to-br from-accent-500 to-accent-700"
          />
          <span className="font-semibold tracking-tight text-ink-900">
            AgentPack
          </span>
          <span className="ml-1 text-ink-400">Registry</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm text-ink-600">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="hover:text-ink-900">
              {item.label}
            </Link>
          ))}
          <Link
            href="/packs"
            className="rounded-md bg-ink-900 px-3 py-1.5 text-xs font-semibold text-white shadow-soft hover:bg-ink-800"
          >
            Browse packs
          </Link>
        </nav>
      </div>
    </header>
  );
}
