const insecureSecretValues = new Set([
  'change-me',
  'change-me-internal',
  'replace-with-32-plus-char-random-secret',
  'replace-with-32-plus-char-random-internal-key',
]);

export function isWeakSharedSecret(
  secret: string | undefined,
  minimumLength = 32,
): boolean {
  if (!secret) {
    return true;
  }

  const normalized = secret.trim();
  if (normalized.length < minimumLength) {
    return true;
  }

  return insecureSecretValues.has(normalized.toLowerCase());
}
