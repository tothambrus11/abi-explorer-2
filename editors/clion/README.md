# ABI Explorer for CLion

CLion 2025.3 or newer. Struct layouts from the project's own compiler and flags:

- **Quick documentation** (hover, or `F1`/`Ctrl+Q`) on a struct or member name, or any use of a
  struct (`std::string` too): its size, alignment, padding, byte map and member table.
- **Settings | Tools | ABI Explorer**: a target to lay structs out for
  instead of the project's own (`armv7-unknown-linux-gnueabihf`, say).
- **Pin layout with static_assert** and **Reorder members by alignment** (`Alt+Enter` on a
  struct; the reorder where its member order wastes space).
- **Struct Layout** tool window, following the caret: click a member to jump to it, copy the
  layout as text, or reorder the members where that saves space.

Each file's compiler and switches come from CLion's project model (CMake, Makefile, compilation
database and the rest), so no `compile_commands.json` is needed. The language server runs on the
machine's Node.js 20 or newer, or on Node.js downloaded once when there is none.

Build with `npm run build` in `editors/` (the plugin bundles `server/dist` and `panel/dist`), then
`./gradlew buildPlugin` here; the plugin is in `build/distributions/`. `./gradlew -p core test`
tests the IDE-free logic.
