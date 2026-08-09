import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { salonConfig } from "@/config/salon";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: `${salonConfig.name} | 口コミ作成`,
  description: "アンケートの回答をもとに、Google口コミの下書きを作成します。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-ivory">{children}</body>
    </html>
  );
}
