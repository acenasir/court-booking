import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Court Booking",
  description: "Reserve a court at Riverside Racquet Club. No double-bookings, ever.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
