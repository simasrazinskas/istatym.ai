import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'istatym.ai',
  description: 'Agentinis teisinis asistentas pagal Lietuvos teisės aktus.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="lt">
      <body>{children}</body>
    </html>
  );
}
