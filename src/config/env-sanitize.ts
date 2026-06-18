export function sanitizeEnv(value: unknown) {
  if (value === undefined || value === null) {
    return "";
  }

  let sanitized = String(value).trim();

  if (
    (sanitized.startsWith('"') && sanitized.endsWith('"')) ||
    (sanitized.startsWith("'") && sanitized.endsWith("'"))
  ) {
    sanitized = sanitized.slice(1, -1).trim();
  }

  return sanitized;
}

export function getEnvPreview(value: unknown) {
  const sanitized = sanitizeEnv(value);

  return {
    configured: sanitized.length > 0,
    length: sanitized.length,
    prefix: sanitized.slice(0, 4),
  };
}
