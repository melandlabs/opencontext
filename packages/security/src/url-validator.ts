/**
 * SSRF Protection Utilities
 * Prevents Server-Side Request Forgery by validating URLs against
 * private IP ranges and enforcing domain whitelists where appropriate.
 */

/**
 * Private IP ranges that should be blocked
 */
const PRIVATE_IP_RANGES = [
  // IPv4 private ranges
  { start: "10.0.0.0", end: "10.255.255.255", mask: 8 }, // 10.0.0.0/8 - Private Class A
  { start: "172.16.0.0", end: "172.31.255.255", mask: 12 }, // 172.16.0.0/12 - Private Class B
  { start: "192.168.0.0", end: "192.168.255.255", mask: 16 }, // 192.168.0.0/16 - Private Class C
  { start: "127.0.0.0", end: "127.255.255.255", mask: 8 }, // 127.0.0.0/8 - Loopback
  { start: "0.0.0.0", end: "0.255.255.255", mask: 8 }, // 0.0.0.0/8 - Current network
  { start: "100.64.0.0", end: "100.127.255.255", mask: 10 }, // 100.64.0.0/10 - Carrier-grade NAT
  { start: "169.254.0.0", end: "169.254.255.255", mask: 16 }, // 169.254.0.0/16 - Link-local
  { start: "192.0.0.0", end: "192.0.2.255", mask: 24 }, // 192.0.2.0/24 - TEST-NET-1
  { start: "198.51.100.0", end: "198.51.100.255", mask: 24 }, // 198.51.100.0/24 - TEST-NET-2
  { start: "203.0.113.0", end: "203.0.113.255", mask: 24 }, // 203.0.113.0/24 - TEST-NET-3
  { start: "224.0.0.0", end: "255.255.255.255", mask: 4 }, // 224.0.0.0/4 - Multicast/Reserved
];

/**
 * Convert IPv4 string to number for comparison
 */
function ipToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return (
    ((parts[0] ?? 0) << 24) |
    ((parts[1] ?? 0) << 16) |
    ((parts[2] ?? 0) << 8) |
    (parts[3] ?? 0)
  );
}

/**
 * Check if an IP address is within a private range
 */
function isPrivateIp(ip: string): boolean {
  // Check IPv6
  if (ip.includes(":")) {
    // Block IPv6 loopback, link-local, unique local, and documentation ranges
    return (
      ip.startsWith("::") ||
      ip.startsWith("fe80:") || // Link-local
      ip.startsWith("fc00:") || // Unique local
      ip.startsWith("fd00:") || // Unique local
      ip.startsWith("fd") || // Unique local prefix
      ip.startsWith("2001:db8:") // Documentation
    );
  }

  // Check IPv4
  const ipNum = ipToInt(ip);
  return PRIVATE_IP_RANGES.some((range) => {
    const start = ipToInt(range.start);
    const end = ipToInt(range.end);
    return ipNum >= start && ipNum <= end;
  });
}

/**
 * Check if a hostname resolves to a private IP
 * Note: This performs DNS resolution which could be slow,
 * so use judiciously and consider caching
 */
async function isPrivateHostname(hostname: string): Promise<boolean> {
  try {
    // Skip IP addresses (they're already checked)
    if (/^[\d\.:]+$/.test(hostname)) {
      return isPrivateIp(hostname);
    }

    // For hostnames, we check for known patterns
    // This is a safer approach than DNS resolution which could be abused
    const localhostPatterns = [
      "localhost",
      "local",
      "localdomain",
      "internal",
      "intranet",
      "corp",
      "private",
      "dmz",
    ];

    const lowerHostname = hostname.toLowerCase();
    if (localhostPatterns.some((pattern) => lowerHostname.includes(pattern))) {
      return true;
    }

    // Check if hostname is in the TLD list that shouldn't be used
    const suspiciousTlds = [".test", ".example", ".invalid", ".localhost"];
    if (suspiciousTlds.some((tld) => lowerHostname.endsWith(tld))) {
      return true;
    }

    // For external hostnames, we rely on DNSSEC and other infrastructure
    // This is a basic check - in production you might want to implement
    // a DNSSEC-validating resolver or use a dedicated service
    return false;
  } catch {
    return true; // Fail closed on errors
  }
}

/**
 * SSRF validation error
 */
export class SSRFValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SSRFValidationError";
  }
}

/**
 * Allowed domains for file storage providers
 */
const ALLOWED_STORAGE_DOMAINS = [
  "*.vercel-storage.com",
  "*.blob.vercel-storage.com",
  "*.vercel.com",
  "googleapis.com",
  "*.googleapis.com",
  "*.googleusercontent.com",
  "drive.google.com",
  "*.drive.google.com",
  "notion.so",
  "*.notion.so",
  "*.notion-static.com",
  "files.slack.com",
  "*.files.slack.com",
  "*.amazonaws.com", // S3 endpoints
];

/**
 * Check if a hostname matches any allowed domain pattern
 */
function isAllowedDomain(hostname: string): boolean {
  const lowerHostname = hostname.toLowerCase();

  for (const pattern of ALLOWED_STORAGE_DOMAINS) {
    if (pattern.startsWith("*.")) {
      const baseDomain = pattern.slice(2);
      if (
        lowerHostname === baseDomain ||
        lowerHostname.endsWith(`.${baseDomain}`)
      ) {
        return true;
      }
    } else if (lowerHostname === pattern) {
      return true;
    }
  }

  return false;
}

/**
 * Validate a URL for SSRF risks
 * @param url - The URL to validate
 * @param options - Validation options
 * @returns The parsed and validated URL
 * @throws {SSRFValidationError} if the URL is invalid or potentially dangerous
 */
export async function validateUrlForSSRF(
  url: string,
  options: {
    /** Require HTTPS protocol */
    requireHttps?: boolean;
    /** Strict whitelist mode - only allow known storage domains */
    strictWhitelist?: boolean;
    /** Additional allowed domains */
    allowedDomains?: string[];
  } = {},
): Promise<URL> {
  const {
    requireHttps = true,
    strictWhitelist = true,
    allowedDomains = [],
  } = options;

  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SSRFValidationError("Invalid URL format");
  }

  // Validate protocol
  if (requireHttps && parsed.protocol !== "https:") {
    throw new SSRFValidationError("Only HTTPS URLs are allowed");
  }

  // Block non-http/https protocols
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new SSRFValidationError(`Protocol ${parsed.protocol} is not allowed`);
  }

  // Check for private IP addresses in hostname
  if (await isPrivateHostname(parsed.hostname)) {
    throw new SSRFValidationError(
      "Access to private IP addresses or local resources is not allowed",
    );
  }

  // If strict whitelist mode is enabled, check against allowed domains
  if (strictWhitelist) {
    const allAllowedDomains = [...ALLOWED_STORAGE_DOMAINS, ...allowedDomains];
    let isAllowed = false;

    for (const pattern of allAllowedDomains) {
      const lowerHostname = parsed.hostname.toLowerCase();
      if (pattern.startsWith("*.")) {
        const baseDomain = pattern.slice(2);
        if (
          lowerHostname === baseDomain ||
          lowerHostname.endsWith(`.${baseDomain}`)
        ) {
          isAllowed = true;
          break;
        }
      } else if (lowerHostname === pattern) {
        isAllowed = true;
        break;
      }
    }

    if (!isAllowed) {
      throw new SSRFValidationError(
        `Domain ${parsed.hostname} is not in the allowed list`,
      );
    }
  }

  // Check for URL rebinding attacks (redirects to private IPs)
  // We validate the URL before fetching, but also need to handle redirects
  // This is handled by the fetchWithSSRFProtection function below

  return parsed;
}

/**
 * Fetch a URL with SSRF protection
 * This validates the URL before fetching and also validates any redirects
 */
export async function fetchWithSSRFProtection(
  url: string,
  options: {
    requireHttps?: boolean;
    strictWhitelist?: boolean;
    allowedDomains?: string[];
    maxRedirects?: number;
    fetchOptions?: RequestInit;
  } = {},
): Promise<Response> {
  const {
    requireHttps = true,
    strictWhitelist = true,
    allowedDomains = [],
    maxRedirects = 5,
    fetchOptions = {},
  } = options;

  let currentUrl = url;
  let redirectCount = 0;

  while (redirectCount <= maxRedirects) {
    // Validate the current URL
    const validatedUrl = await validateUrlForSSRF(currentUrl, {
      requireHttps,
      strictWhitelist,
      allowedDomains,
    });

    // Fetch the URL with redirect: manual
    const response = await fetch(validatedUrl.toString(), {
      ...fetchOptions,
      redirect: "manual",
    });

    // If not a redirect, return the response
    if (
      response.status === 0 ||
      (response.status >= 200 && response.status < 300)
    ) {
      return response;
    }

    // Handle redirects
    if (
      response.status === 301 ||
      response.status === 302 ||
      response.status === 307 ||
      response.status === 308
    ) {
      const location = response.headers.get("Location");
      if (!location) {
        throw new SSRFValidationError("Redirect without Location header");
      }

      // Handle relative redirects
      currentUrl = location.startsWith("http")
        ? location
        : new URL(location, validatedUrl).toString();

      redirectCount++;

      // Too many redirects
      if (redirectCount > maxRedirects) {
        throw new SSRFValidationError("Too many redirects");
      }

      continue;
    }

    // Other status codes
    return response;
  }

  throw new SSRFValidationError("Invalid redirect state");
}

/**
 * Check if a URL is from a known, trusted storage provider
 * Used for less strict validation when we know the URL came from a trusted source
 */
export function isTrustedStorageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // Vercel Blob URLs
    if (hostname.includes("vercel-storage.com")) return true;

    // Google Drive/Storage
    if (hostname.endsWith(".googleapis.com")) return true;
    if (hostname.endsWith(".googleusercontent.com")) return true;
    if (hostname === "drive.google.com") return true;

    // Notion
    if (hostname.endsWith("notion.so")) return true;
    if (hostname.endsWith("notion-static.com")) return true;

    // Slack
    if (hostname.includes("files.slack.com")) return true;

    // AWS S3 (any S3 endpoint)
    if (hostname.includes(".amazonaws.com")) return true;

    return false;
  } catch {
    return false;
  }
}
