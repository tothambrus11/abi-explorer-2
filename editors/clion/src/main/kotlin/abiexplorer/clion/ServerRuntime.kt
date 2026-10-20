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
import com.intellij.util.system.CpuArch
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import kotlin.io.path.exists

/**
 * What it takes to start the server: Node.js and the server script.
 *
 * The script ships inside the plugin and is copied out next to the IDE's other
 * caches, once per plugin version; Node.js is the machine's own when new
 * enough, or an official build downloaded once. The server then downloads the
 * engine on its first start.
 */
class ServerRuntime(private val node: Path, private val script: Path) {
    fun commandLine(): GeneralCommandLine =
        GeneralCommandLine(node.toString(), script.toString(), "--stdio").withCharset(Charsets.UTF_8)

    companion object {
        private val home: Path get() = Path.of(PathManager.getSystemPath(), "abi-explorer")

        /** Set once `prepare` has run in this IDE session. */
        @Volatile
        var ready: ServerRuntime? = null
            private set

        /** Finds or downloads Node.js and copies the server out; runs a process, so never on the EDT. */
        fun prepare(indicator: ProgressIndicator): ServerRuntime {
            ready?.let { return it }
            indicator.text = "Looking for Node.js ${NodeRuntime.MINIMUM_MAJOR} or later"
            val node = systemNode() ?: downloadedNode().takeIf { it.exists() } ?: downloadNode(indicator)
            return ServerRuntime(node, extractServer()).also { ready = it }
        }

        private fun systemNode(): Path? {
            val node = PathEnvironmentVariableUtil.findInPath(if (SystemInfo.isWindows) "node.exe" else "node") ?: return null
            val version = runCatching { ExecUtil.execAndGetOutput(GeneralCommandLine(node.path, "--version"), 5_000) }.getOrNull()
            return node.toPath().takeIf { version != null && NodeRuntime.isSupported(version.stdout) }
        }

        private fun downloadNode(indicator: ProgressIndicator): Path {
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
                val decompressor = if (distribution.archiveName.endsWith(".zip")) Decompressor.Zip(archive) else Decompressor.Tar(archive)
                decompressor.extract(home.resolve("node"))
            } finally {
                Files.deleteIfExists(archive)
            }
            return downloadedNode()
        }

        private fun distribution(): NodeRuntime.Distribution = NodeRuntime.distribution(
            os = when {
                SystemInfo.isWindows -> "windows"
                SystemInfo.isMac -> "mac"
                else -> "linux"
            },
            arch = if (CpuArch.isArm64()) "arm64" else "x64",
        )

        private fun downloadedNode(): Path = home.resolve("node").resolve(distribution().executable)

        /**
         * Copies the bundled server out of the plugin into a folder named for its
         * contents' hash, so an update (or a development build) brings a new
         * server. Each file is written beside its target and moved into place,
         * so an interrupted copy is never mistaken for a finished one.
         */
        private fun extractServer(): Path {
            val files = mapOf(
                "server.js" to resource("/server/server.js"),
                "engineWorker.js" to resource("/server/engineWorker.js"),
                // The bundle is an ES module.
                "package.json" to """{ "type": "module" }""".toByteArray(),
            )
            val digest = MessageDigest.getInstance("SHA-256")
            files.values.forEach(digest::update)
            val hash = digest.digest().take(6).joinToString("") { "%02x".format(it) }
            val directory = home.resolve("server-$hash")
            Files.createDirectories(directory)
            for ((name, content) in files) {
                val target = directory.resolve(name)
                if (target.exists()) continue
                val partial = Files.createTempFile(directory, name, ".partial")
                Files.write(partial, content)
                Files.move(partial, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
            }
            return directory.resolve("server.js")
        }

        private fun resource(path: String): ByteArray =
            ServerRuntime::class.java.getResourceAsStream(path)?.use { it.readBytes() } ?: error("the plugin is missing $path")

        private fun sha256(file: Path): String =
            MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(file)).joinToString("") { "%02x".format(it) }
    }
}
