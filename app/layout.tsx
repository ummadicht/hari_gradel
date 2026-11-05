import type { Metadata, Viewport } from "next";
import { Space_Grotesk, DM_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";
import PWARegister from "./components/PWARegister";

const spaceGrotesk = Space_Grotesk({
  variable: "--font-heading",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});
const dmSans = DM_Sans({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "GradeIQ — browser-native phone grading",
  description:
    "Zero-install, gamified phone testing + AI cosmetic grading. No app, no cable — the phone grades itself in its own browser.",
  appleWebApp: {
    capable: true,
    title: "GradeIQ",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  themeColor: "#0e8f86",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${dmSans.variable} ${geistMono.variable}`}
    >
      <body>
        {children}
        <PWARegister />
      </body>
    </html>
  );
}
