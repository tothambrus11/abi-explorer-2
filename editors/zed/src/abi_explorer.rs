//! ABI Explorer for Zed: runs the language server (the `@hylo-lang/abi-explorer`
//! package from this version's GitHub release) with Zed's own Node.js, next to
//! clangd. Zed shows its hovers and code actions; there is no panel, since
//! extensions cannot add one.

use std::fs;
use zed_extension_api::{self as zed, serde_json, settings::LspSettings, LanguageServerId, Result};

const REPOSITORY: &str = "tothambrus11/abi-explorer-2";
/// The server released together with this extension: one version for both.
const VERSION: &str = env!("CARGO_PKG_VERSION");

struct AbiExplorer;

impl AbiExplorer {
    /// The server's entry script, downloaded from the `editors-v<version>`
    /// release the first time; later sessions, offline ones too, reuse it.
    fn server_script(&self, id: &LanguageServerId) -> Result<String> {
        let dir = format!("server-{VERSION}");
        let script = format!("{dir}/package/bin/abi-explorer-lsp.js");
        if fs::metadata(&script).is_ok_and(|metadata| metadata.is_file()) {
            return Ok(script);
        }
        zed::set_language_server_installation_status(
            id,
            &zed::LanguageServerInstallationStatus::Downloading,
        );
        let result = download(&dir);
        let status = match &result {
            Ok(()) => zed::LanguageServerInstallationStatus::None,
            Err(error) => zed::LanguageServerInstallationStatus::Failed(error.clone()),
        };
        zed::set_language_server_installation_status(id, &status);
        result.map(|()| script)
    }
}

fn download(dir: &str) -> Result<()> {
    let release = zed::github_release_by_tag_name(REPOSITORY, &format!("editors-v{VERSION}"))?;
    let name = format!("hylo-lang-abi-explorer-{VERSION}.tgz");
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| format!("the editors-v{VERSION} release has no {name}"))?;
    zed::download_file(&asset.download_url, dir, zed::DownloadedFileType::GzipTar)?;
    // Servers of earlier versions are no longer used.
    for entry in fs::read_dir(".")
        .map_err(|error| error.to_string())?
        .flatten()
    {
        let other = entry.file_name().to_string_lossy().into_owned();
        if other.starts_with("server-") && other != dir {
            fs::remove_dir_all(entry.path()).ok();
        }
    }
    Ok(())
}

impl zed::Extension for AbiExplorer {
    fn new() -> Self {
        AbiExplorer
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
                args: binary
                    .and_then(|binary| binary.arguments)
                    .unwrap_or_default(),
                env: Vec::new(),
            });
        }

        // An `abi-explorer-lsp` on PATH (`npm install -g`) before the release's.
        if let Some(path) = worktree.which("abi-explorer-lsp") {
            return Ok(zed::Command {
                command: path,
                args: vec!["--stdio".into()],
                env: Vec::new(),
            });
        }

        let script = std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(self.server_script(id)?);
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
        if let (Some(options), Some(serde_json::Value::Object(user))) =
            (options.as_object_mut(), user)
        {
            options.extend(user);
        }
        Ok(Some(options))
    }
}

zed::register_extension!(AbiExplorer);
