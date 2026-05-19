import type { Metadata } from "next";
import "./globals.css";
import { Header } from "@/components/Header";

export const metadata: Metadata = {
  title: "AgentPack Registry — AgentPacks for every AI surface",
  description:
    "Atomic packages for AI workflows. Write once. Install anywhere agents work.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Header />
        <main className="py-12">{children}</main>
        <footer className="border-t border-ink-100 py-8">
          <div className="container-page flex flex-wrap items-center justify-between gap-4 text-sm text-ink-400">
            <span>AgentPack Registry · AgentPack standard v1.0</span>
            <span>
              <a className="hover:text-ink-600" href="/docs">
                Docs
              </a>{" "}
              ·{" "}
              <a className="hover:text-ink-600" href="/validate">
                Validate
              </a>{" "}
              ·{" "}
              <a
                className="hover:text-ink-600"
                href="https://agentpack.dev"
              >
                agentpack.dev
              </a>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
