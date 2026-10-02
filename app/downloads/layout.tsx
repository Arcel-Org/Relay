import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Download Relay — Relay',
  description: 'Download Relay for Android, Linux (.deb / AppImage), or use the web app. Native desktop clients with the same post-quantum end-to-end encryption.',
};

export default function DownloadsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
