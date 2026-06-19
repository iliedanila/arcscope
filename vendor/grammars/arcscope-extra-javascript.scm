; arcscope-authored additions, appended to the upstream javascript tags.scm.
; Captures exported non-function const/let bindings (upstream only tags
; function-valued declarators). Scoped to export_statement so file-local consts
; don't pollute the index. Verified to compile against the javascript grammar.

(export_statement
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name))) @definition.constant
