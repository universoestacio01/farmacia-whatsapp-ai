export function providerFailure(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : "";
  const code = text.match(/(?:HTTP|respondeu|auth_http_)\s*(\d{3})/i);
  const statusCode = code ? Number(code[1]) : undefined;
  const failureReason = statusCode === 401 || statusCode === 403 ? "authentication_failed"
    : statusCode === 429 ? "rate_limited"
      : statusCode ? `http_${statusCode}`
        : /timeout|abort|deadline|budget/i.test(text) ? "timeout_or_budget"
          : /invalid/i.test(text) ? "invalid_response" : /token/i.test(text) ? "authentication_unavailable" : "network_error";
  return { statusCode, failureReason };
}
