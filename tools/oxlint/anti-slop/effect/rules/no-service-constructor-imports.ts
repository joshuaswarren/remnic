import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const SERVICE_CONSTRUCTOR_NAME = /^make[A-Z]/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

function isProjectLocalImport(source: string): boolean {
	return source.startsWith("./") || source.startsWith("../");
}

function getImportedName(specifier: ESTree.ImportSpecifier): string {
	if (specifier.imported.type === "Identifier") return specifier.imported.name;
	return specifier.imported.value;
}

/** Keep dependency-bearing Effect service constructors local to their owning capability modules. */
export const noServiceConstructorImportsRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow project-local make<CapabilityName> imports outside test and spec files.",
		},
		messages: {
			serviceConstructorImport:
				'Do not import Effect service constructor "{{name}}" into runtime code. Import the owning Layer, yield the contextual service, and allow its requirements to propagate to the composition root.',
		},
	},
	createOnce(context) {
		// Evaluated per file: createOnce runs once per lint run, so a captured
		// filename would freeze one verdict for every file (issue found in
		// review). The visitor receives the current file's context each time.
		return {
			ImportDeclaration(node) {
				const isTestFile = TEST_FILE.test(context.filename.replaceAll("\\", "/"));
				if (isTestFile || !isProjectLocalImport(node.source.value)) return;

				for (const specifier of node.specifiers) {
					if (specifier.type !== "ImportSpecifier") continue;

					const importedName = getImportedName(specifier);
					if (!SERVICE_CONSTRUCTOR_NAME.test(importedName)) continue;

					context.report({
						node: specifier,
						messageId: "serviceConstructorImport",
						data: { name: importedName },
					});
				}
			},
		};
	},
});
