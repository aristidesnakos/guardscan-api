export const metadata = {
  title: 'GuardScan API',
  description: 'Backend for GuardScan — barcode product safety scoring',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
