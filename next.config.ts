import type { NextConfig } from "next";

const securityHeaders = [
  // Block clickjacking — never embed this app in an iframe.
  { key: "X-Frame-Options", value: "DENY" },
  // Stop browsers from MIME-sniffing responses away from declared types.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Send only the origin (not the full path/query) on cross-origin nav.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Lock down APIs we don't use.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  // Force HTTPS for two years (no-op over plain HTTP / localhost).
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Apply to every route.
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
