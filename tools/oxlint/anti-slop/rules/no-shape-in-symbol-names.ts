import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const FORBIDDEN_SYMBOL_NAME = "shape";

function containsForbiddenSymbolName(name: string): boolean {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}

/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
  },
  createOnce(context) {
    const reportForbiddenSymbolName = (node: ESTree.Node & { name: string }) => {
      if (!containsForbiddenSymbolName(node.name)) return;
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name: node.name },
      });
    };

    return {
      Identifier(node) {
        const parent = node.parent;
        if (parent.type === "MemberExpression" && !parent.computed && parent.property === node) return;
        if (parent.type === "Property" && !parent.computed && parent.key === node && parent.value !== node) return;
        if ((parent.type === "MethodDefinition" || parent.type === "PropertyDefinition" || parent.type === "AccessorProperty" || parent.type === "TSPropertySignature" || parent.type === "TSMethodSignature") && !parent.computed && parent.key === node) return;
        if (parent.type === "ImportSpecifier" && parent.imported === node && parent.local !== node) return;
        if (parent.type === "ExportSpecifier" && parent.exported === node && parent.local !== node) return;
        reportForbiddenSymbolName(node);
      },
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier(node) {
        if (node.parent.type === "JSXAttribute" || node.parent.type === "JSXNamespacedName") return;
        if (node.parent.type === "JSXMemberExpression" && node.parent.property === node) return;
        reportForbiddenSymbolName(node);
      },
    };
  },
});
