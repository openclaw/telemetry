import {
	isArrayLiteralExpression,
	isIdentifier,
	isNewExpression,
	isStringLiteral,
	isVariableStatement,
	NodeFlags,
} from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { API } from "typescript/unstable/sync";

/** Read literal public metadata without evaluating imports or computed expressions. */
export function readProviderOverlays(source) {
	const root = "/public-vocabulary";
	const file = `${root}/providers.ts`;
	const config = `${root}/tsconfig.json`;
	const fs = createVirtualFileSystem({
		[file]: source,
		[config]: JSON.stringify({
			files: ["providers.ts"],
			compilerOptions: { noLib: true, noResolve: true },
		}),
	});
	const api = new API({
		cwd: root,
		fs: {
			...fs,
			// Missing virtual files must not fall through to the real filesystem.
			readFile: (path) => fs.readFile(path) ?? null,
			getAccessibleEntries: (path) => fs.getAccessibleEntries(path) ?? { files: [], directories: [] },
		},
	});
	try {
		const project = api.updateSnapshot({ openProjects: [config] }).getProject(config);
		const parsed = project?.program.getSourceFile(file);
		if (!parsed || project.program.getSyntacticDiagnostics(file).length) {
			throw new Error("Cannot parse upstream provider overlay metadata");
		}
		const declarations = parsed.statements.filter(isVariableStatement).flatMap((statement) =>
			statement.declarationList.declarations
				.filter((declaration) => isIdentifier(declaration.name) &&
					declaration.name.text === "BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS")
				.map((declaration) => ({ declaration, flags: statement.declarationList.flags })),
		);
		if (declarations.length !== 1 || !(declarations[0].flags & NodeFlags.Const)) {
			throw new Error("Expected exactly one upstream provider overlay const");
		}
		const value = declarations[0].declaration.initializer;
		if (!value || !isNewExpression(value) || !isIdentifier(value.expression) ||
			value.expression.text !== "Set" || value.arguments?.length !== 1 ||
			!isArrayLiteralExpression(value.arguments[0]) ||
			!value.arguments[0].elements.every(isStringLiteral)) {
			throw new Error("Upstream provider overlays must be a Set of string literals");
		}
		return value.arguments[0].elements.map((element) => element.text);
	} finally {
		api.close();
	}
}
