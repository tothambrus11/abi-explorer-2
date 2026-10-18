package abiexplorer.clion

import abiexplorer.core.NodeRuntime
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.execution.util.ExecUtil
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.util.SystemInfo
import com.intellij.util.io.Decompressor
import com.intellij.util.io.HttpRequests
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import kotlin.io.path.exists
import kotlin.io.path.readBytes

/**
 * What it takes to start the server: Node.js and the server script.
 *
 * The script ships inside the plugin and is copied out next to the IDE's other
 * caches; Node.js is the machine's own when new enough, or an official build
 * downloaded once. The server then downloads the engine on its first start.
 */
class ServerRuntime(val node: Path, val script: Path) {
    fun commandLine(): GeneralCommandLine =
        GeneralCommandLine(node.toString(), script.toString(), "--stdio").withCharset(Charsets.UTF_8)

    companion object {
        private val home: Path get() = Path.of(PathManager.getSystemPath(), "abi-explorer")

        /** Ready without downloading anything, or null. */
        fun findInstalled(): ServerRuntime? {
            val node = systemNode() ?: downloadedNode().takeIf { it.exists() } ?: return null
            return ServerRuntime(node, extractServer())
        }

        /** Downloads Node.js if the machine has none; call off the EDT. */
        fun install(indicator: ProgressIndicator): ServerRuntime {
            findInstalled()?.let { return it }
            indicator.text = "Downloading Node.js ${NodeRuntime.DOWNLOAD_VERSION} for ABI Explorer"
            val distribution = distribution()
            val archive = Files.createTempFile("abi-explorer-node", distribution.archiveName)
            try {
                HttpRequests.request(distribution.url).saveToFile(archive.toFile(), indicator)
                val shasums = HttpRequests.request(distribution.shasumsUrl).readString(indicator)
                val expected = NodeRuntime.expectedSha256(shasums, distribution.archiveName)
                check(expected != null && expected == sha256(archive)) {
                    "${distribution.archiveName} does not match nodejs.org's SHASUMS256.txt"
                }
                val target = home.resolve("node")
                val decompressor = if (distribution.archiveName.endsWith(".zip")) Decompressor.Zip(archive) else Decompressor.Tar(archive)
                decompressor.extract(target)
            } finally {
                Files.deleteIfExists(archive)
            }
            return ServerRuntime(downloadedNode(), extractServer())
        }

        private fun systemNode(): Path? {
            val node = PathEnvironmentVariableUtil.findInPath(if (SystemInfo.isWindows) "node.exe" else "node") ?: return null
            val version = runCatching { ExecUtil.execAndGetOutput(GeneralCommandLine(node.path, "--version"), 5_000) }.getOrNull()
            return node.toPath().takeIf { version != null && NodeRuntime.isSupported(version.stdout) }
        }

        private fun distribution(): NodeRuntime.Distribution = NodeRuntime.distribution(
            os = when {
                SystemInfo.isWindows -> "windows"
                SystemInfo.isMac -> "mac"
                else -> "linux"
            },
            arch = if (SystemInfo.isAarch64) "arm64" else "x64",
        )

        private fun downloadedNode(): Path = home.resolve("node").resolve(distribution().executable)

        /** Copies the bundled server out of the plugin, once per plugin version. */
        private fun extractServer(): Path {
            val directory = home.resolve("server-${ServerRuntime::class.java.`package`.implementationVersion ?: "dev"}")
            for (name in listOf("server.js", "engineWorker.js")) {
                val target = directory.resolve(name)
                if (target.exists()) continue
                Files.createDirectories(directory)
                val resource = ServerRuntime::class.java.getResourceAsStream("/server/$name") ?: error("plugin is missing server/$name")
                resource.use { Files.copy(it, target) }
            }
            // The bundle is an ES module.
            Files.writeString(directory.resolve("package.json"), """{ "type": "module" }""")
            return directory.resolve("server.js")
        }

        private fun sha256(file: Path): String =
            MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
    }
}
