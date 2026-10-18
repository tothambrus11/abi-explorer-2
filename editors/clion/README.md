# ABI Explorer for CLion

CLion 2025.3 or newer. Struct layouts from the project's own compiler and flags:

- **Quick documentation** (hover, or `F1`/`Ctrl+Q`) on a struct or member name, or any use of a
  struct (`std::string` too): its size, alignment, padding, byte map and member table.
- **Settings | Tools | ABI Explorer**: a target to lay structs out for
  instead of the project's own (`armv7-unknown-linux-gnueabihf`, say).
- A **warning** on a struct whose member order wastes space, saying how small another order
  would make it; its fix, **Reorder members by alignment** (`Alt+Enter`), moves the member
  lines into that order. A struct laid out on purpose keeps its order with
  `// abi-explorer: keep order` above it, which **Keep this member order** writes.
  **Pin layout with static_assert** is offered on any struct.
- **Struct Layout** tool window, drawn as the web explorer draws a layout (tabs, size tiles, a
  byte grid with bit-fields bit by bit, the nested member table) and following the caret: click a
  member to jump to it, a compound member's name to open its struct, or copy the layout as text.

Each file's compiler and switches come from CLion's project model (CMake, Makefile, compilation
database and the rest), so no `compile_commands.json` is needed. The language server runs on the
machine's Node.js 20 or newer, or on Node.js downloaded once when there is none.

Build with `npm run build` in `editors/` (the plugin bundles `server/dist` and `panel/dist`), then
`./gradlew buildPlugin` here; the plugin is in `build/distributions/`. `./gradlew -p core test`
tests the IDE-free logic.
