import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { SERVICE_NAME, SERVICE_TAGLINE } from "@/lib/brand";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: `${SERVICE_NAME} | ${SERVICE_TAGLINE}`,
  description: "アンケートの回答をもとに、Google口コミの下書きを作成します。",
};

// Explicit rather than relying on Next.js's default, so this can never be
// silently dropped or overridden by another metadata export in the tree.
// No maximumScale/userScalable restriction -- pinch zoom must stay available.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets fixed-position bars use env(safe-area-inset-bottom) to clear the
  // iOS home-indicator instead of that value resolving to 0.
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
