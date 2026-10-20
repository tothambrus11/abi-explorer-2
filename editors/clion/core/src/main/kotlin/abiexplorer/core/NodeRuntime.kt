package abiexplorer.core

/**
 * Which Node.js runs the server: one already on the machine when it is new
 * enough, otherwise an official build downloaded once into the IDE's system
 * directory. The plugin itself ships no binaries.
 */
object NodeRuntime {
    /** The oldest Node.js the server supports (`engines` in its package.json). */
    const val MINIMUM_MAJOR = 20

    /** The release downloaded when the machine has no usable Node.js. */
    const val DOWNLOAD_VERSION = "v22.22.0"

    /** `v22.11.0` or `22.11.0` as its major version; null for anything else. */
    fun majorVersion(versionOutput: String): Int? =
        Regex("""^v?(\d+)\.\d+\.\d+""").find(versionOutput.trim())?.groupValues?.get(1)?.toIntOrNull()

    fun isSupported(versionOutput: String): Boolean = (majorVersion(versionOutput) ?: 0) >= MINIMUM_MAJOR

    /** An official Node.js build for one platform. */
    data class Distribution(val archiveName: String, val url: String, val shasumsUrl: String, val executable: String)

    /** `os` is `windows`, `mac` or `linux`; `arch` is `x64` or `arm64`. */
    fun distribution(os: String, arch: String, version: String = DOWNLOAD_VERSION): Distribution {
        val platform = when (os) {
            "windows" -> "win"
            "mac" -> "darwin"
            "linux" -> "linux"
            else -> throw IllegalArgumentException("no Node.js build for $os")
        }
        require(arch == "x64" || arch == "arm64") { "no Node.js build for $arch" }
        val base = "node-$version-$platform-$arch"
        val archive = if (os == "windows") "$base.zip" else "$base.tar.gz"
        val root = "https://nodejs.org/dist/$version"
        return Distribution(
            archiveName = archive,
            url = "$root/$archive",
            shasumsUrl = "$root/SHASUMS256.txt",
            executable = if (os == "windows") "$base/node.exe" else "$base/bin/node",
        )
    }

    /** The SHA-256 that SHASUMS256.txt lists for `archiveName`. */
    fun expectedSha256(shasums: String, archiveName: String): String? =
        shasums.lineSequence()
            .map { it.trim().split(Regex("""\s+""")) }
            .firstOrNull { it.size == 2 && it[1] == archiveName }
            ?.get(0)
            ?.lowercase()
}
