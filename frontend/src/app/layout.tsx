import type { Metadata } from "next";
import { Inter, Outfit } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  weight: ["300", "400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: "SOP Forge | Enterprise AI Voice Triage Engine",
  description:
    "SOP Forge is a next-generation enterprise AI voice triage system that routes employee calls to the correct department using real-time speech recognition and intelligent intent analysis.",
  keywords: ["SOP", "voice AI", "enterprise triage", "call routing", "speech recognition"],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body className={`${inter.variable} ${outfit.variable} ${inter.className}`}>
        {children}
      </body>
    </html>
  );
}
