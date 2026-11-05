import type { Metadata, Viewport } from "next";
import "./globals.css";
import PWARegister from "./components/PWARegister";

export const metadata: Metadata = {
  title: "GradeIQ — browser-native phone grading",
  description:
    "Zero-install, gamified phone testing + AI cosmetic grading. No app, no cable — the phone grades itself in its own browser.",
  openGraph: {
    title: "GradeIQ — browser-native phone grading",
    description:
      "Zero-install, gamified phone testing + AI cosmetic grading. No app, no cable — the phone grades itself in its own browser.",
  },
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
    <html lang="en">
      <body>
        {children}
        <PWARegister />
      </body>
    </html>
  );
}
