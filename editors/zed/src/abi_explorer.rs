//! ABI Explorer for Zed: runs the `abi-explorer-lsp` npm package with Zed's
//! own Node.js, next to clangd. Zed shows its hovers and code actions; there is
//! no panel, since extensions cannot add one.

use zed_extension_api::{self as zed, serde_json, settings::LspSettings, LanguageServerId, Result};

const PACKAGE: &str = "abi-explorer-lsp";
const SERVER_SCRIPT: &str = "node_modules/abi-explorer-lsp/bin/abi-explorer-lsp.js";

struct AbiExplorer {
    /// Set once this session has made sure the package is current.
    installed: bool,
}

impl AbiExplorer {
    /// Installs or updates the package. Offline, an installed copy is used as
    /// it is; without one, the status shows why the server cannot start.
    fn ensure_package(&mut self, id: &LanguageServerId) -> Result<()> {
        if self.installed {
            return Ok(());
        }
        zed::set_language_server_installation_status(
            id,
            &zed::LanguageServerInstallationStatus::CheckingForUpdate,
        );
        let installed = zed::npm_package_installed_version(PACKAGE)?;
        let result = match zed::npm_package_latest_version(PACKAGE) {
            Ok(latest) if installed.as_deref() != Some(latest.as_str()) => {
                zed::set_language_server_installation_status(
                    id,
                    &zed::LanguageServerInstallationStatus::Downloading,
                );
                zed::npm_install_package(PACKAGE, &latest)
            }
            Ok(_) => Ok(()),
            Err(_) if installed.is_some() => Ok(()),
            Err(error) => Err(error),
        };
        let status = match &result {
            Ok(()) => zed::LanguageServerInstallationStatus::None,
            Err(error) => zed::LanguageServerInstallationStatus::Failed(error.clone()),
        };
        zed::set_language_server_installation_status(id, &status);
        self.installed = result.is_ok();
        result
    }
}

impl zed::Extension for AbiExplorer {
    fn new() -> Self {
        AbiExplorer { installed: false }
    }

    fn language_server_command(
        &mut self,
        id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        // `lsp.abi-explorer-lsp.binary` in settings points at a local build.
        let binary = LspSettings::for_worktree(id.as_ref(), worktree)?.binary;
        if let Some(path) = binary.as_ref().and_then(|binary| binary.path.clone()) {
            return Ok(zed::Command {
                command: path,
                args: binary.and_then(|binary| binary.arguments).unwrap_or_default(),
                env: Vec::new(),
            });
        }

        self.ensure_package(id)?;
        let script = std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(SERVER_SCRIPT);
        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![script.to_string_lossy().into_owned(), "--stdio".into()],
            env: Vec::new(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        // Zed renders SVG images in hovers; anything the user set wins.
        let mut options = serde_json::json!({ "hoverImages": true });
        let user = LspSettings::for_worktree(id.as_ref(), worktree)?.initialization_options;
        if let (Some(options), Some(serde_json::Value::Object(user))) = (options.as_object_mut(), user) {
            options.extend(user);
        }
        Ok(Some(options))
    }
}

zed::register_extension!(AbiExplorer);
