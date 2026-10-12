import type { Metadata } from 'next'
import { headers } from 'next/headers'
import './globals.css'
import { ToastContainer } from '@/components/ToastNotification'

export const metadata: Metadata = {
  title: 'Relay — Encrypted Messaging',
  description: 'Relay. End-to-end encrypted messaging for high-trust networks.',
  applicationName: 'Relay',
  robots: { index: true, follow: true },
  openGraph: {
    title: 'Relay — Encrypted Messaging',
    description: 'End-to-end encrypted messaging for high-trust networks.',
    siteName: 'Relay',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Relay — Encrypted Messaging',
    description: 'End-to-end encrypted messaging for high-trust networks.',
  },
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Read the nonce injected by middleware so inline scripts can carry it.
  // Without it the nonce-based CSP would block these bootstrap scripts.
  const nonce = (await headers()).get('x-nonce') ?? '';

  return (
    <html lang="en" suppressHydrationWarning data-theme="crimson" data-relay-url={process.env.RELAY_WS_URL || process.env.NEXT_PUBLIC_RELAY_URL || ''}>
      <head>
        {/* One-time migration: copy legacy `polar:*` localStorage keys to
            the new `relay:*` namespace. Runs before any app code reads them. */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var F='relay:storage-migration:polar-v1';if(localStorage.getItem(F))return;var ks=[];for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k&&k.indexOf('polar:')===0)ks.push(k);}for(var j=0;j<ks.length;j++){var ok=ks[j];var nk='relay:'+ok.slice(6);if(localStorage.getItem(nk)!==null)continue;var v=localStorage.getItem(ok);if(v!==null)localStorage.setItem(nk,v);}localStorage.setItem(F,String(Date.now()));}catch(e){}})();`,
          }}
        />
        {/* Apply saved theme before first paint to avoid flash. */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('relay:theme');var ok=['crimson','ocean','forest','golden','violet','arctic','rose','solar','zen'];var active=(t&&ok.indexOf(t)!==-1)?t:'crimson';document.documentElement.setAttribute('data-theme',active);if(active!=='arctic')document.documentElement.classList.add('dark');else document.documentElement.classList.remove('dark');}catch(e){}})();`,
          }}
        />
        {/* Apply marketing-surface theme (light default, dark if saved). */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=localStorage.getItem('relay:marketing-theme');var mt=m==='dark'?'dark':'light';document.documentElement.setAttribute('data-mk-theme',mt);}catch(e){}})();`,
          }}
        />
      </head>
      <body className="antialiased">
        {children}
        <ToastContainer />
      </body>
    </html>
  )
}
