import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "vibe-make",
  description: "Describe a 3D object. AI builds it in OpenSCAD. Export to STL.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
