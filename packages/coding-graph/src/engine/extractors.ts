/**
 * Per-language symbol extractors for the tier-1 languages.
 *
 * Each tier-1 language has a `LanguageExtractor` providing tree-sitter query
 * strings. The `emit.ts` module compiles these against the loaded grammar,
 * runs them against the root node, and walks captures into FileIR.
 *
 * Query capture conventions (fixed across all languages):
 *
 *   Definitions — every definition pattern captures:
 *     @def.<kind>  the definition node (span = [startIndex, endIndex))
 *     @name        the identifier node whose .text is the symbol name
 *     <kind> ∈ function | method | class | interface | enum | type | module
 *
 *   Imports — every import pattern captures:
 *     @__import.stmt  the import-statement node (grouping key)
 *     @import.module  the module specifier text (cleaned in emit.ts)
 *     @import.name    zero or more imported-name identifiers
 *
 *   Exports — @export.name
 *   Call sites — @call.callee
 *   Routes — @route.verb + @route.path + @route.handler
 */
import type { CodingGraphLanguage } from "@remnic/core";

export type DefKind = "function" | "method" | "class" | "interface" | "enum" | "type" | "module";

export interface LanguageExtractor {
  readonly definitionsQuery: string;
  readonly importsQuery: string;
  readonly exportsQuery: string;
  readonly callSitesQuery: string;
  readonly routesQuery: string;
}

// ===========================================================================
// JS family (JavaScript, TypeScript, TSX) — shared definition + call patterns.
// ===========================================================================

const JS_FAMILY_DEFINITIONS = `
(function_declaration name: (identifier) @name) @def.function
(method_definition name: (property_identifier) @name) @def.method
(class_declaration name: (type_identifier) @name) @def.class
(interface_declaration name: (type_identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(type_alias_declaration name: (type_identifier) @name) @def.type
`.trim();

const JS_IMPORTS = `
(import_statement
  source: (string (string_fragment) @import.module)) @__import.stmt
(import_statement
  (import_clause (identifier) @import.name)
  source: (string (string_fragment) @import.module)) @__import.stmt
(import_statement
  (import_clause (namespace_import (identifier) @import.name))
  source: (string (string_fragment) @import.module)) @__import.stmt
(import_statement
  (import_clause (named_imports (import_specifier name: (identifier) @import.name)))
  source: (string (string_fragment) @import.module)) @__import.stmt
`.trim();

// TS/TSX exports — class/interface names use type_identifier.
const TS_EXPORTS = `
(export_statement declaration: (function_declaration name: (identifier) @export.name))
(export_statement declaration: (class_declaration name: (type_identifier) @export.name))
(export_statement (lexical_declaration (variable_declarator name: (identifier) @export.name)))
(export_statement declaration: (enum_declaration name: (identifier) @export.name))
(export_statement declaration: (interface_declaration name: (type_identifier) @export.name))
(export_statement (export_clause (export_specifier name: (identifier) @export.name)))
`.trim();

// JavaScript exports — class names use identifier (no type_identifier in JS grammar).
const JS_EXPORTS = `
(export_statement declaration: (function_declaration name: (identifier) @export.name))
(export_statement declaration: (class_declaration name: (identifier) @export.name))
(export_statement (lexical_declaration (variable_declarator name: (identifier) @export.name)))
(export_statement (export_clause (export_specifier name: (identifier) @export.name)))
`.trim();

const JS_CALLS = `
(call_expression function: (identifier) @call.callee)
(call_expression function: (member_expression property: (property_identifier) @call.callee))
`.trim();

const JS_ROUTES = `
(call_expression
  function: (member_expression
    object: (identifier) @__route.app
    property: (property_identifier) @route.verb)
  arguments: (arguments . (string (string_fragment) @route.path) . (arrow_function) @route.handler)
  (#match? @route.verb "^(get|post|put|patch|delete|head|options|all|use)$"))
(call_expression
  function: (member_expression
    object: (identifier) @__route.app
    property: (property_identifier) @route.verb)
  arguments: (arguments . (string (string_fragment) @route.path) . (function_expression) @route.handler)
  (#match? @route.verb "^(get|post|put|patch|delete|head|options|all|use)$"))
`.trim();

// ===========================================================================
// Per-language extractors.
// ===========================================================================

const TYPESCRIPT_EXTRACTOR: LanguageExtractor = {
  definitionsQuery: JS_FAMILY_DEFINITIONS,
  importsQuery: JS_IMPORTS,
  exportsQuery: TS_EXPORTS,
  callSitesQuery: JS_CALLS,
  routesQuery: JS_ROUTES,
};

const TSX_EXTRACTOR: LanguageExtractor = TYPESCRIPT_EXTRACTOR;

const JAVASCRIPT_EXTRACTOR: LanguageExtractor = {
  definitionsQuery: `
(function_declaration name: (identifier) @name) @def.function
(method_definition name: (property_identifier) @name) @def.method
(class_declaration name: (identifier) @name) @def.class
`.trim(),
  importsQuery: JS_IMPORTS,
  exportsQuery: JS_EXPORTS,
  callSitesQuery: JS_CALLS,
  routesQuery: JS_ROUTES,
};

const PYTHON_EXTRACTOR: LanguageExtractor = {
  definitionsQuery: `
(function_definition name: (identifier) @name) @def.function
(class_definition name: (identifier) @name) @def.class
`.trim(),
  importsQuery: `
(import_statement (dotted_name) @import.module) @__import.stmt
(import_from_statement module_name: (dotted_name) @import.module) @__import.stmt
`.trim(),
  exportsQuery: ``,
  callSitesQuery: `
(call function: (identifier) @call.callee)
(call function: (attribute attribute: (identifier) @call.callee))
`.trim(),
  routesQuery: `
(decorated_definition
  (decorator
    (call function: (attribute attribute: (identifier) @route.verb)
      arguments: (argument_list (string) @route.path)))
  definition: (function_definition name: (identifier) @route.handler)
  (#match? @route.verb "^(get|post|put|patch|delete|route|api_route)$"))
`.trim(),
};

const GO_EXTRACTOR: LanguageExtractor = {
  definitionsQuery: `
(function_declaration name: (identifier) @name) @def.function
(method_declaration name: (field_identifier) @name) @def.method
(type_spec name: (type_identifier) @name type: (struct_type)) @def.class
(type_spec name: (type_identifier) @name type: (interface_type)) @def.interface
(type_spec name: (type_identifier) @name type: (type_identifier)) @def.type
`.trim(),
  importsQuery: `
(import_spec path: (interpreted_string_literal) @import.module) @__import.stmt
`.trim(),
  exportsQuery: ``,
  callSitesQuery: `
(call_expression function: (identifier) @call.callee)
(call_expression function: (selector_expression field: (field_identifier) @call.callee))
`.trim(),
  routesQuery: ``,
};

const RUST_EXTRACTOR: LanguageExtractor = {
  definitionsQuery: `
(function_item name: (identifier) @name) @def.function
(function_signature_item name: (identifier) @name) @def.function
(struct_item name: (type_identifier) @name) @def.class
(enum_item name: (type_identifier) @name) @def.enum
(trait_item name: (type_identifier) @name) @def.interface
(type_item name: (type_identifier) @name) @def.type
(mod_item name: (identifier) @name) @def.module
`.trim(),
  importsQuery: `
(use_declaration (scoped_identifier) @import.module) @__import.stmt
(use_declaration (scoped_use_list) @import.module) @__import.stmt
`.trim(),
  exportsQuery: ``,
  callSitesQuery: `
(call_expression function: (identifier) @call.callee)
(call_expression function: (field_expression field: (field_identifier) @call.callee))
(call_expression function: (scoped_identifier) @call.callee)
`.trim(),
  routesQuery: ``,
};

const JAVA_EXTRACTOR: LanguageExtractor = {
  definitionsQuery: `
(class_declaration name: (identifier) @name) @def.class
(interface_declaration name: (identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(record_declaration name: (identifier) @name) @def.class
(method_declaration name: (identifier) @name) @def.method
(constructor_declaration name: (identifier) @name) @def.method
`.trim(),
  importsQuery: `
(import_declaration (scoped_identifier) @import.module) @__import.stmt
`.trim(),
  exportsQuery: ``,
  callSitesQuery: `
(method_invocation name: (identifier) @call.callee)
`.trim(),
  routesQuery: ``,
};

const C_EXTRACTOR: LanguageExtractor = {
  definitionsQuery: `
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @def.function
(type_definition declarator: (type_identifier) @name) @def.type
`.trim(),
  importsQuery: `
(preproc_include path: (system_lib_string) @import.module) @__import.stmt
(preproc_include path: (string_literal) @import.module) @__import.stmt
`.trim(),
  exportsQuery: ``,
  callSitesQuery: `
(call_expression function: (identifier) @call.callee)
`.trim(),
  routesQuery: ``,
};

const CPP_EXTRACTOR: LanguageExtractor = {
  definitionsQuery: `
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @def.function
(function_definition declarator: (function_declarator declarator: (field_identifier) @name)) @def.method
(class_specifier name: (type_identifier) @name) @def.class
(struct_specifier name: (type_identifier) @name) @def.class
(enum_specifier name: (type_identifier) @name) @def.enum
(namespace_definition name: (namespace_identifier) @name) @def.module
`.trim(),
  importsQuery: `
(preproc_include path: (system_lib_string) @import.module) @__import.stmt
(preproc_include path: (string_literal) @import.module) @__import.stmt
`.trim(),
  exportsQuery: ``,
  callSitesQuery: `
(call_expression function: (identifier) @call.callee)
(call_expression function: (field_expression field: (field_identifier) @call.callee))
`.trim(),
  routesQuery: ``,
};

const CSHARP_EXTRACTOR: LanguageExtractor = {
  definitionsQuery: `
(class_declaration name: (identifier) @name) @def.class
(interface_declaration name: (identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(struct_declaration name: (identifier) @name) @def.class
(method_declaration name: (identifier) @name) @def.method
`.trim(),
  importsQuery: `
(using_directive (identifier) @import.module) @__import.stmt
(using_directive (qualified_name (identifier) @import.module)) @__import.stmt
`.trim(),
  exportsQuery: ``,
  callSitesQuery: `
(invocation_expression function: (identifier) @call.callee)
(invocation_expression function: (member_access_expression name: (identifier) @call.callee))
`.trim(),
  routesQuery: ``,
};

const RUBY_EXTRACTOR: LanguageExtractor = {
  definitionsQuery: `
(class name: (constant) @name) @def.class
(module name: (constant) @name) @def.module
(method name: (identifier) @name) @def.method
(singleton_method name: (identifier) @name) @def.method
`.trim(),
  importsQuery: `
(call
  method: (identifier) @__import.method
  arguments: (argument_list (string) @import.module)
  (#match? @__import.method "^(require|require_relative|load)$")) @__import.stmt
`.trim(),
  exportsQuery: ``,
  callSitesQuery: `
(call method: (identifier) @call.callee)
`.trim(),
  routesQuery: ``,
};

const PHP_EXTRACTOR: LanguageExtractor = {
  definitionsQuery: `
(class_declaration name: (name) @name) @def.class
(interface_declaration name: (name) @name) @def.interface
(trait_declaration name: (name) @name) @def.class
(function_definition name: (name) @name) @def.function
(method_declaration name: (name) @name) @def.method
`.trim(),
  importsQuery: `
(namespace_use_declaration (namespace_use_clause (qualified_name) @import.module)) @__import.stmt
`.trim(),
  exportsQuery: ``,
  callSitesQuery: `
(function_call_expression function: (name) @call.callee)
(member_call_expression (name) @call.callee)
`.trim(),
  routesQuery: ``,
};

const KOTLIN_EXTRACTOR: LanguageExtractor = {
  definitionsQuery: `
(class_declaration (type_identifier) @name) @def.class
(object_declaration (type_identifier) @name) @def.module
(function_declaration (simple_identifier) @name) @def.function
`.trim(),
  importsQuery: `
(import_header (identifier) @import.module) @__import.stmt
(import_header (identifier (simple_identifier) @import.module)) @__import.stmt
`.trim(),
  exportsQuery: ``,
  callSitesQuery: `
(call_expression (simple_identifier) @call.callee)
`.trim(),
  routesQuery: ``,
};

const SWIFT_EXTRACTOR: LanguageExtractor = {
  definitionsQuery: `
(class_declaration name: (type_identifier) @name) @def.class
(protocol_declaration name: (type_identifier) @name) @def.interface
(function_declaration name: (simple_identifier) @name) @def.function
`.trim(),
  importsQuery: `
(import_declaration (identifier) @import.module) @__import.stmt
`.trim(),
  exportsQuery: ``,
  callSitesQuery: `
(call_expression (simple_identifier) @call.callee)
`.trim(),
  routesQuery: ``,
};

const BASH_EXTRACTOR: LanguageExtractor = {
  definitionsQuery: `
(function_definition name: (word) @name) @def.function
`.trim(),
  importsQuery: ``,
  exportsQuery: ``,
  callSitesQuery: `
(command name: (command_name (word) @call.callee))
`.trim(),
  routesQuery: ``,
};

// ===========================================================================
// Registry — single source of truth.
// ===========================================================================

export const EXTRACTORS: Record<CodingGraphLanguage, LanguageExtractor> = {
  typescript: TYPESCRIPT_EXTRACTOR,
  tsx: TSX_EXTRACTOR,
  javascript: JAVASCRIPT_EXTRACTOR,
  python: PYTHON_EXTRACTOR,
  go: GO_EXTRACTOR,
  rust: RUST_EXTRACTOR,
  java: JAVA_EXTRACTOR,
  c: C_EXTRACTOR,
  cpp: CPP_EXTRACTOR,
  csharp: CSHARP_EXTRACTOR,
  ruby: RUBY_EXTRACTOR,
  php: PHP_EXTRACTOR,
  kotlin: KOTLIN_EXTRACTOR,
  swift: SWIFT_EXTRACTOR,
  bash: BASH_EXTRACTOR,
};

const VALID_KINDS = new Set<string>([
  "function",
  "method",
  "class",
  "interface",
  "enum",
  "type",
  "module",
]);

/**
 * Extract the SymbolIR kind from a `@def.<kind>` capture name.
 * Returns `null` for non-definition captures or invalid kinds.
 */
export function kindFromCapture(captureName: string): DefKind | null {
  if (!captureName.startsWith("def.")) return null;
  const kind = captureName.slice(4);
  if (!VALID_KINDS.has(kind)) return null;
  return kind as DefKind;
}
