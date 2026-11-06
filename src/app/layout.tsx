import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "StripePulse · Interactive Stripe Simulation Dashboard",
  description:
    "Premium SaaS dashboard simulating Stripe payment processing, webhook pipelines, subscription lifecycles, retries and idempotency — synchronized with a real backend (MongoDB replica set, HMAC-signed webhooks).",
  keywords: ["Stripe", "webhooks", "simulation", "dashboard", "subscriptions", "payment retries"],
  authors: [{ name: "StripePulse" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "StripePulse · Interactive Stripe Simulation",
    description: "Animated, backend-synchronized Stripe payment pipeline simulation.",
    siteName: "StripePulse",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
