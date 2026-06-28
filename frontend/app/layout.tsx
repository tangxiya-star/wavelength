import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "wavelength",
  description: "Predicted brainwaves for short-form clips.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="p-6">{children}</main>
      </body>
    </html>
  );
}
