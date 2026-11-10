const SINGLE_VALUE_PARAMETERS = [
  'client_id',
  'redirect_uri',
  'response_type',
  'response_mode',
  'scope',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
];

/** Validate the provider destination before using its query or opening it. */
export function parseProviderAuthUrl(authUrl: string, endpoint: string): URL | null {
  try {
    const parsed = new URL(authUrl);
    if (
      parsed.origin + parsed.pathname !== endpoint ||
      parsed.username ||
      parsed.password ||
      authUrl.includes('#')
    )
      return null;
    // URLSearchParams tolerates malformed escapes; do not reinterpret a security parameter.
    decodeURIComponent(parsed.search);
    if (SINGLE_VALUE_PARAMETERS.some((name) => parsed.searchParams.getAll(name).length > 1)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
