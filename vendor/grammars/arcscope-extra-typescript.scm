; arcscope-authored additions, appended to the upstream javascript + typescript
; tags.scm. The stock tree-sitter tags omit these TS definition forms, which an
; agent realistically navigates to; without them find_def loses to grep on TS.
; Verified to compile against the typescript AND tsx grammars (web-tree-sitter 0.26.9),
; and to capture the forms below on real code (see the engine extraction tests).
; Capture convention matches upstream: @definition.<kind> on the node, @name on its identifier.

(type_alias_declaration
  name: (type_identifier) @name) @definition.type

(enum_declaration
  name: (identifier) @name) @definition.enum

; `namespace X {}` parses as internal_module (upstream only tags `module "x" {}`).
(internal_module
  name: (identifier) @name) @definition.module

; Exported const/let bindings of any value (upstream only tags function-valued ones).
; Scoped to export_statement so file-local consts don't pollute the index.
(export_statement
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name))) @definition.constant
