// Hylo for Monaco, ported from the editor support Hylo already has.
//
// The grammar is hylo-lang/vscode-hylo's `syntaxes/hylo.tmLanguage.json`, and
// the brackets and comment markers below are its `language-configuration.json`.
// Nothing here is invented: the keyword groups, the literal forms, the comment
// markers and the declaration rules are that file's, group for group, and the
// comments name the scope each one came from so the two can be compared.
//
// It is a port rather than the grammar itself. Monaco tokenizes with Monarch;
// running the TextMate grammar as written would mean shipping vscode-textmate
// and an Oniguruma build, and then teaching this app's themes to colour
// TextMate scopes, which are a far finer set of names than the seven colours a
// theme here defines. The port maps each scope onto the token this app already
// themes, so Hylo is coloured by the same palette as C and every theme covers
// it without being touched.
//
// Two deliberate differences, both marked at the rule:
//
//  - The grammar's `type` and `trait` rules name a capture the pattern has no
//    group for, so the name a declaration introduces is scoped in intent and
//    not in fact. The intent is what is ported.
//  - Its keyword lists are the older surface syntax, and predate `struct`,
//    `enum` and `case`, which is what the compiler behind this app parses and
//    what every Hylo example here is written in. Those are added, from
//    hylo-new's own lexer, and kept apart below.

import type * as monaco from './monaco-slim';

/** The language id, which is also what a Hylo model's URI is named for. */
export const HYLO_LANGUAGE_ID = 'hylo';

/**
 * The keywords of `#keywords`, in the grammar's own groups.
 *
 * The groups are kept because they are how the upstream file is organised, and
 * a keyword added there should be added to the group it belongs to. They all
 * become one token here: this app's palette has a single keyword colour, so
 * splitting control flow from modifiers would produce the same pixels.
 */
const GRAMMAR_KEYWORDS = [
  // keyword.fun / keyword.control.import
  'fun',
  'import',
  // keyword.control.transfer
  'break',
  'continue',
  'return',
  'throw',
  'yield',
  'yielded',
  // keyword.control.loop
  'while',
  'for',
  'do',
  'unroll',
  'in',
  // keyword.control.conditional
  'if',
  'else',
  'match',
  'where',
  // keyword.control.scope
  'catch',
  'defer',
  'try',
  // keyword.type
  'conformance',
  'extension',
  'namespace',
  'typealias',
  // keyword.operator
  'operator',
  'postfix',
  'prefix',
  'infix',
  // keyword.modifier
  'public',
  'internal',
  'fileprivate',
  'private',
  'static',
  // keyword.convention
  'inout',
  'let',
  'set',
  'sink',
  // keyword.subscript
  'property',
  'subscript',
  // keyword.var / keyword.misc
  'var',
  'deinit',
  'some',
  'spawn',
  'is',
  'as',
  // variable.language: not a keyword to the parser, but every editor colours
  // it as one, and this palette has nothing finer to say about it.
  'self',
  'Self',
  // storage.type: the heads of #declarations, which are keywords wherever they
  // appear and not only where they introduce a name.
  'type',
  'trait',
];

/**
 * What the grammar predates.
 *
 * hylo-lang/vscode-hylo describes the older surface syntax. The compiler that
 * answers this app's queries takes `struct`, `enum` and `case`, and its own
 * examples are written in them, so leaving these out would mean shipping
 * highlighting that misses the first word of every declaration on screen.
 * Taken from hylo-new's lexer (`Sources/FrontEnd/Parser/Lexer.swift`), and kept
 * separate so a grammar update stays a question about the list above.
 */
const ADDED_KEYWORDS = ['struct', 'enum', 'case', 'init', 'given', 'module', 'auto'];

/**
 * Every word the tokenizer treats as a keyword: the grammar's, and the ones it
 * predates.
 *
 * Exported so that what the highlighting claims about the language can be
 * asserted somewhere other than by reading pixels.
 */
export const HYLO_KEYWORDS = [...GRAMMAR_KEYWORDS, ...ADDED_KEYWORDS];

/** `#literals`: boolean, nil and any, which this palette colours as keywords. */
const CONSTANTS = ['true', 'false', 'nil', 'any'];

/** The words a comment marker is called out for, from `#commentContents`. */
const MARKERS = 'TODO|FIXME|XXX|NOTE';

/**
 * The tokenizer.
 *
 * Rules appear in the grammar's order, except that comments and strings come
 * first: a keyword inside either is not a keyword, and Monarch decides by the
 * first rule that matches where it stands.
 *
 * Token names are Monaco's, and every one of them is a name `compileTheme` in
 * `$core/themes` gives a colour, so a Hylo buffer is painted by the same seven
 * colours as a C one.
 */
export const HYLO_TOKENS: monaco.languages.IMonarchLanguage = {
  defaultToken: '',
  ignoreCase: false,
  keywords: HYLO_KEYWORDS,
  constants: CONSTANTS,
  brackets: [
    { open: '{', close: '}', token: 'delimiter.curly' },
    { open: '[', close: ']', token: 'delimiter.square' },
    { open: '(', close: ')', token: 'delimiter.parenthesis' },
  ],

  tokenizer: {
    root: [
      // #comments. A line comment is one rule rather than a state because a
      // Monarch state is left by matching something, and there is nothing to
      // match at the end of a line: a state entered at `//` would still be in
      // force on the next line, and colour the rest of the file as a comment.
      // The cost is that the marker is called out once per line, at the first
      // one, which is where a TODO is written.
      [
        new RegExp(`(//[^\\r\\n]*?)(\\b(?:${MARKERS})\\b:?)([^\\r\\n]*)`),
        ['comment', 'annotation', 'comment'],
      ],
      [/\/\/[^\r\n]*/, 'comment'],
      [/\/\*/, 'comment', '@blockComment'],

      // #literals: string, with `\.` escapes.
      [/"/, { token: 'string.quote', bracket: '@open', next: '@string' }],

      // #declarations. The name a declaration introduces is coloured here and
      // not by the identifier rule below, which is the one place this file
      // knows more than the word in front of it.
      //
      // `fun` first, exactly as the grammar has it: a name followed by `(` or
      // `<`. A function name has no colour of its own in this palette, so it
      // is an identifier; what the rule is really for is that `fun` is a
      // keyword even where the parser would call the name one.
      // The space between is the default token rather than Monaco's `white`:
      // this app's themes name no `white` rule, and a token nothing colours is
      // a token that falls through to the editor's foreground anyway.
      [/\b(fun)(\s+)([A-Za-z_]\w*)(?=\s*[(<])/, ['keyword', '', 'identifier']],
      // `type`, `trait`, and the two the grammar predates. The grammar names a
      // capture for this name and has no group for it; this is that intent.
      [/\b(type|trait|struct|enum)(\s+)([A-Za-z_]\w*)/, ['keyword', '', 'type']],

      // #literals: numeric. Hex, octal and binary before decimal, which is not
      // the grammar's order but is the same result: its decimal pattern ends in
      // `\b`, which `0x1f` cannot satisfy after its leading `0`.
      [/\b0x[a-fA-F0-9_]+\b/, 'number.hex'],
      [/\b0o[0-7_]+\b/, 'number'],
      [/\b0b[01_]+\b/, 'number'],
      [/\b[0-9][0-9_]*\b/, 'number'],

      // #keywords, and the constants of #literals. Anything else a reader wrote
      // is an identifier, including a type name: the grammar colours a type by
      // where it is declared, never by how it is spelled.
      [
        /[A-Za-z_]\w*/,
        { cases: { '@keywords': 'keyword', '@constants': 'keyword', '@default': 'identifier' } },
      ],

      // Punctuation, which the grammar does not describe: it scopes only the
      // angle brackets of a generic clause, and leaves every other mark to the
      // theme's default. Coloured here so that a Hylo buffer and a C one look
      // like the same editor.
      [/[{}()[\]]/, '@brackets'],
      [/[,;:.]/, 'delimiter'],
      // Punctuation, like every other operator in this app: C and C++ tokenise
      // theirs as delimiters, and one colour for both languages is one colour
      // a reader has to think about.
      [/[-+*/%<>=!&|^~?]+/, 'delimiter'],
    ],

    /** `#literals` -> `string`: to the closing quote, `\.` escaped. */
    string: [
      [/\\./, 'string.escape'],
      [/"/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
      [/[^"\\]+/, 'string'],
    ],

    /**
     * `#comments` -> `comment.block`, which does not nest.
     *
     * The classes are written so that every rule consumes at least one
     * character: a Monarch rule that can match nothing makes no progress and
     * hangs the tokenizer.
     */
    blockComment: [
      [/\*\//, 'comment', '@pop'],
      [new RegExp(`\\b(?:${MARKERS})\\b:?`), 'annotation'],
      [/[^*TFXN]+/, 'comment'],
      [/[*TFXN]/, 'comment'],
    ],
  },
};

/**
 * Brackets, comment markers and the pairs the editor closes for you, from
 * vscode-hylo's `language-configuration.json`.
 *
 * This is what makes Ctrl+/ comment a Hylo line with `//` rather than with
 * whatever the previous language used, and what the bracket matcher reads.
 */
export const HYLO_CONFIGURATION: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};
