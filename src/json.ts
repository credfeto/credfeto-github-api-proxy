/**
 * Shared by meta.ts's injectInstalledVersion and rewrite-urls.ts's rewriteJsonBody,
 * which both need to parse a response body that may not be valid JSON without throwing.
 */
export function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
