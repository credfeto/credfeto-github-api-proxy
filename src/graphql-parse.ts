import { Kind, OperationTypeNode, parse } from "graphql";
import type { DocumentNode, FragmentDefinitionNode, SelectionSetNode } from "graphql";

function tryParse(query: string): DocumentNode | null {
  try {
    return parse(query, { noLocation: true });
  } catch {
    return null;
  }
}

function collectRootFields(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  visitedFragments: Set<string>,
  names: Set<string>,
): void {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      // The real field name, never the alias: `x: updateRef(...)` still runs updateRef.
      names.add(selection.name.value);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      collectRootFields(selection.selectionSet, fragments, visitedFragments, names);
    } else {
      const fragmentName = selection.name.value;
      const fragment = fragments.get(fragmentName);
      // A fragment cycle is invalid GraphQL, but guard anyway so a hostile document cannot recurse forever.
      if (fragment !== undefined && !visitedFragments.has(fragmentName)) {
        visitedFragments.add(fragmentName);
        collectRootFields(fragment.selectionSet, fragments, visitedFragments, names);
      }
    }
  }
}

export function parseMutationRootFields(query: string): Set<string> | null {
  const document = tryParse(query);
  if (document === null) {
    return null;
  }

  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }

  // Every mutation operation is inspected, not only the one operationName selects,
  // so a harmless leading operation cannot hide a later blocked one.
  const names = new Set<string>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION && definition.operation === OperationTypeNode.MUTATION) {
      collectRootFields(definition.selectionSet, fragments, new Set<string>(), names);
    }
  }
  return names;
}
