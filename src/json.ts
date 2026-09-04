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

// Called for every node in the tree walked by walkJson, with the node's own
// key when it is an object property (undefined for array items and the
// root). Returning a [value, changed] tuple replaces the node without
// recursing into it further; returning undefined continues the default
// structural recursion into arrays/objects (and leaves primitives as-is).
export type JsonVisitor = (value: unknown, key: string | undefined) => [unknown, boolean] | undefined;

// Recursively walks a parsed JSON value, letting `visit` transform any node
// (by value and/or its parent key) and otherwise recursing structurally into
// arrays and objects. Bounded by MAX_JSON_WALK_DEPTH to guard against
// pathological/cyclic nesting.
export function walkJson(value: unknown, visit: JsonVisitor, depth = 0, key: string | undefined = undefined): [unknown, boolean] {
  const handled = visit(value, key);
  if (handled !== undefined) return handled;

  if (depth > MAX_JSON_WALK_DEPTH) return [value, false];

  if (Array.isArray(value)) {
    let changed = false;
    const result = value.map((item) => {
      const [rewrittenItem, itemChanged] = walkJson(item, visit, depth + 1);
      if (itemChanged) changed = true;
      return rewrittenItem;
    });
    return [result, changed];
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const result: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(value as Record<string, unknown>)) {
      const [rewrittenVal, valChanged] = walkJson(val, visit, depth + 1, k);
      if (valChanged) changed = true;
      result[k] = rewrittenVal;
    }
    return [result, changed];
  }
  return [value, false];
}
