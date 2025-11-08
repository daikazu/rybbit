import "@/app/global.css";
import { RootProvider } from "fumadocs-ui/provider/next";
import { Inter } from "next/font/google";
import Script from "next/script";
import type { ReactNode } from "react";
import type { Metadata } from "next";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: {
    default: "Rybbit - Privacy-First Web Analytics Platform",
    template: "%s | Rybbit",
  },
  description:
    "Open-source, privacy-focused web analytics platform. Track your website performance without compromising user privacy. Self-hostable alternative to Google Analytics.",
  keywords: [
    "web analytics",
    "privacy analytics",
    "open source analytics",
    "Google Analytics alternative",
    "website tracking",
    "self-hosted analytics",
  ],
  authors: [{ name: "Rybbit Team" }],
  creator: "Rybbit",
  publisher: "Rybbit",
  metadataBase: new URL("https://rybbit.com"),
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://rybbit.com",
    siteName: "Rybbit",
    title: "Rybbit - Privacy-First Web Analytics Platform",
    description:
      "Open-source, privacy-focused web analytics platform. Track your website performance without compromising user privacy.",
    images: [
      {
        url: "/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: "Rybbit Analytics Dashboard",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Rybbit - Privacy-First Web Analytics Platform",
    description:
      "Open-source, privacy-focused web analytics platform. Track your website performance without compromising user privacy.",
    images: ["/opengraph-image.png"],
    creator: "@yang_frog",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  verification: {
    google: "",
    yandex: "",
    yahoo: "",
  },
};

const isDev = process.env.NODE_ENV === "development";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className="dark">
      <Script
        src="https://demo.rybbit.com/api/script.js"
        data-site-id="21"
        strategy="afterInteractive"
        data-session-replay="true"
        data-web-vitals="true"
        data-track-errors="true"
        data-track-outbound="true"
        {...(isDev && {
          "data-api-key": process.env.NEXT_PUBLIC_RYBBIT_API_KEY,
        })}
      />
      <Script id="matomo" strategy="afterInteractive">
        {`
        var _paq = window._paq = window._paq || [];
        /* tracker methods like "setCustomDimension" should be called before "trackPageView" */
        _paq.push(['trackPageView']);
        _paq.push(['enableLinkTracking']);
        (function() {
          var u = "https://rybbit.matomo.cloud/";
          _paq.push(['setTrackerUrl', u + 'matomo.php']);
          _paq.push(['setSiteId', '1']);
          var d = document, g = d.createElement('script'), s = d.getElementsByTagName('script')[0];
          g.async = true;
          g.src = 'https://cdn.matomo.cloud/rybbit.matomo.cloud/matomo.js';
          s.parentNode.insertBefore(g, s);
        })();
      `}
      </Script>
      <Script id="mixpanel" strategy="afterInteractive">
        {`
        (function(e,c){
          if(!c.__SV){
            var l,h;
            window.mixpanel=c;
            c._i=[];
            c.init=function(q,r,f){ /* ... stub code ... */ };
            c.__SV=1.2;
            var k=e.createElement("script");
            k.type="text/javascript";
            k.async=true;
            k.src="https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js";
            k.onload = function() {
              mixpanel.init('5409b6daffa187942af0f05518c2a4eb', {
                autocapture: true,
                record_sessions_percent: 0
              });
            };
            e=e.getElementsByTagName("script")[0];
            e.parentNode.insertBefore(k,e);
          }
        })(document, window.mixpanel || []);
      `}
      </Script>
      <Script
        src="https://www.googletagmanager.com/gtag/js?id=G-JX2XCP00J1"
        strategy="afterInteractive"
        id="ga-script"
        onLoad={() => {
          (window as any).dataLayer = (window as any).dataLayer || [];
          function gtag(...args: any[]) {
            (window as any).dataLayer.push(args);
          }
          gtag('js', new Date());
          gtag('config', 'G-JX2XCP00J1');
        }}
      />
      <body className={`flex flex-col min-h-screen ${inter.variable} font-sans`}>
        <RootProvider
          theme={{
            forcedTheme: "dark",
            defaultTheme: "dark",
            enabled: false,
          }}
        >
          {children}
        </RootProvider>
      </body>
    </html>
  );
}
