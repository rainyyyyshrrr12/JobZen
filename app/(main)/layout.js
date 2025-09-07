import React from "react";
import { ClerkProvider } from '@clerk/nextjs';
 // Import your global CSS

export const metadata = {
  title: "JobZen - AI Career Assistant",
  description: "Your AI-powered career development platform",
};

const RootLayout = ({ children }) => {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
          <div className="container mx-auto mt-24 mb-20">
            {children}
          </div>
        </body>
      </html>
    </ClerkProvider>
  );
};

export default RootLayout;