import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "salonpack | 口コミ作成支援",
  description: "アンケートの回答をもとに、Google口コミの下書きを作成します。",
};

// Explicit rather than relying on Next.js's default, so this can never be
// silently dropped or overridden by another metadata export in the tree.
// No maximumScale/userScalable restriction -- pinch zoom must stay available.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
