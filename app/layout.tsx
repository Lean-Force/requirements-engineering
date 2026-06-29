import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "USM AI Chat",
  description: "AI Agent Chat で User Story Mapping を整理・可視化するツール",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
