// Guards against pathological/cyclic depth when recursively walking a parsed JSON body.
export const MAX_JSON_WALK_DEPTH = 50;

// Parses a response body that may not be valid JSON without throwing.
export function parseJsonBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
