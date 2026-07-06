import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ship · review',
  description: '方案 → PR 交付流水线的人工 review 控制台',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
