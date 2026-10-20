# Releasing the editor plugins

One version covers everything under `editors/`: the language server (package `@hylo-lang/abi-explorer`,
command `abi-explorer-lsp`), the VS Code extension, the CLion plugin, the Zed extension and the Neovim plugin.

## Cutting a release

```sh
cd editors
node scripts/version.mjs set 0.2.0     # server, vscode, clion, zed and the lock files
git commit -am "editors 0.2.0" && git push
git tag editors-v0.2.0 && git push origin editors-v0.2.0
```

The tag starts [`editors-release.yml`](../.github/workflows/editors-release.yml):

1. **build** checks that every plugin says the tag's version, runs the type checks and tests, and
   builds each package once: `hylo-lang-abi-explorer-<v>.tgz` (the server), `abi-explorer-<v>.vsix`,
   `abi-explorer-clion-<v>.zip`, `abi-explorer-zed-<v>.zip` and `abi-explorer-neovim-<v>.zip`.
2. Five **smoke** jobs, each on its own runner, test those packages end to end: the VSIX in VS Code
   (code-server), the Zed zip in Zed, the plugin in Neovim, the CLion plugin in the IntelliJ
   Platform, and real CMake, Meson, Bazel and Conan projects. The server tarball is the server in
   all of them.
3. Only if all of them pass, the **publish** job runs, in the `release` environment: the VS Code
   extension, on both the Visual Studio Marketplace and Open VSX (where
   VSCodium, Cursor and Windsurf install from). Then a GitHub release for the tag gets every
   package attached, so the server tarball and the CLion, Zed and Neovim archives are
   downloaded from there; nothing publishes those anywhere else. The Zed extension downloads the
   server from its own version's release.

A publish job skips a version that is already published, so a run that failed half way can be
re-run from the Actions page. Pull requests that touch `editors/`, and **Run workflow** on the
Actions page, run steps 1 and 2 only.

## One-time setup

1. **VS Code publisher**: at <https://marketplace.visualstudio.com/manage>, sign in with a
   Microsoft account and create the publisher with ID `hylo-lang` (the extension's `publisher`).
2. **VS Code token**: at <https://dev.azure.com>, create an organization if you have none, then
   User settings › Personal access tokens › New Token, with Organization "All accessible
   organizations" and scope Marketplace › Manage.
3. **Open VSX**: sign in at <https://open-vsx.org> with GitHub, link an Eclipse account and sign
   the publisher agreement (Settings › Profile), and own the namespace `hylo-lang`. Publishing uses
   [trusted publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing): the
   extension's trusted publisher is this repository with workflow `editors-release.yml` (and
   environment `release`, if you pin one), so no secret is needed. Open VSX only accepts that
   registration for an extension that already has a version, so if it refuses, publish the first
   version with a token: Settings › Access Tokens › Generate New Token, saved as an `OVSX_PAT`
   secret, which the workflow then uses instead. Delete the secret once trusted publishing is set
   up.
4. **GitHub**: Settings › Environments › New environment `release`, and add `VSCE_PAT` there.
   Adding yourself as a required reviewer makes every release wait for your click.

| Secret     | Value                                       |
| :--------- | :------------------------------------------ |
| `VSCE_PAT` | the Azure token (2)                         |
| `OVSX_PAT` | only for a first Open VSX version, see (3)  |

The GitHub release uses the workflow's own token. Then cut a release as above: push the tag
`editors-v0.1.0` for the version the plugins say now.

## Installing a build by hand

Every GitHub release, and every workflow run's `editors-<v>` artifact, has the packages; they
install without any marketplace:

- **VS Code** (and VSCodium, Cursor): Extensions › `…` › Install from VSIX…, or
  `code --install-extension abi-explorer-<v>.vsix`.
- **CLion**: Settings › Plugins › ⚙ › Install Plugin from Disk…, then pick
  `abi-explorer-clion-<v>.zip` as it is.
- **Zed**: unzip
  `abi-explorer-zed-<v>.zip` into Zed's installed extensions (`~/.local/share/zed/extensions/installed/`
  on Linux, `~/Library/Application Support/Zed/extensions/installed/` on macOS), so it holds
  `abi-explorer/extension.toml`, and restart Zed. The extension uses an `abi-explorer-lsp` on PATH,
  and otherwise downloads the server from the release.
- **Neovim**: install the server, `npm install -g https://github.com/tothambrus11/abi-explorer-2/releases/download/editors-v<v>/hylo-lang-abi-explorer-<v>.tgz`
  (Node.js 20 or newer), then unzip `abi-explorer-neovim-<v>.zip`
  and point the plugin manager at it, `{ dir = '/path/to/abi-explorer.nvim', main = 'abi-explorer', opts = {} }`
  for lazy.nvim ([neovim/README.md](neovim/README.md)).

## Neovim: nvim-lspconfig and Mason

Following [the Hylo guide](https://hylo-lang.org/blog/nvim-lsp/), Neovim users would ideally get
the server from [Mason](https://github.com/mason-org/mason-registry) (`:MasonInstall
abi-explorer-lsp`, no Node.js setup of their own) and its configuration from
[nvim-lspconfig](https://github.com/neovim/nvim-lspconfig) (`vim.lsp.enable('abi_explorer')`), with
the plugin only for `:AbiLayout`. Both registries take new entries only from projects with at least
100 GitHub stars (Mason also accepts 5000 VS Code Marketplace installs, or an nvim-lspconfig
entry), so these are one-time pull requests for once the project qualifies:

1. nvim-lspconfig: add [`neovim/lsp/abi_explorer.lua`](neovim/lsp/abi_explorer.lua) as
   `lsp/abi_explorer.lua`, unchanged; it already follows their format. Neovim merges every
   `lsp/abi_explorer.lua` on the runtime path, so the plugin's copy and theirs coexist.
2. Mason: its registry installs Node.js servers from npm, so this is the point to publish the
   server there after all (create the npm organization `hylo-lang`, add an `NPM_TOKEN` secret and
   a job that runs `npm publish` on the build's tarball). Then add
   `packages/abi-explorer-lsp/package.yaml`; Renovate keeps its version current after that:

   ```yaml
   ---
   name: abi-explorer-lsp
   description: Struct and class layouts for C and C++, from Clang, in hovers and code actions.
   homepage: https://github.com/tothambrus11/abi-explorer-2
   licenses:
     - Apache-2.0
   languages:
     - C
     - C++
   categories:
     - LSP
   source:
     id: pkg:npm/%40hylo-lang/abi-explorer@0.1.0
   bin:
     abi-explorer-lsp: npm:abi-explorer-lsp
   neovim:
     lspconfig: abi_explorer
   ```

`neovim/test/lspConfig.test.ts` checks the file works on its own, as either registry would use it.

## Where users get it

| Editor                      | Install                                                                            |
| :-------------------------- | :--------------------------------------------------------------------------------- |
| VS Code                     | Extensions › "ABI Explorer", or `code --install-extension hylo-lang.abi-explorer`  |
| VSCodium, Cursor and others | The same, from Open VSX                                                            |
| CLion, Zed, Neovim          | The archives on the GitHub release ([by hand](#installing-a-build-by-hand))        |
| Others                      | `npm install -g` the release's server tarball, and any LSP client                  |

## Publishing CLion, Zed and Neovim later

Not wired into the workflow yet. When it is time: the CLion plugin's first version is uploaded by
hand at plugins.jetbrains.com, then `./gradlew signPlugin publishPlugin -x buildPlugin
-PprebuiltPlugin=abi-explorer-clion-<v>.zip` publishes later ones (`clion/build.gradle.kts` reads
`JETBRAINS_MARKETPLACE_TOKEN` and the signing key from the environment);
`scripts/zed-extensions-pr.sh` opens the pull request on zed-industries/extensions; and a
`neovim` branch holding `editors/neovim` alone (`git subtree split --prefix editors/neovim`) lets
plugin managers install from GitHub.
