package abiexplorer.core

/** One entry of a compilation database, as the server's `abiExplorer/compileCommands` takes it. */
data class CompileCommand(val directory: String, val file: String, val arguments: List<String>)

/**
 * CLion's project model (CMake, Makefile, Bazel and compilation database
 * projects alike) gives each file a compiler, a working directory and the
 * compiler's switches; together they are the file's compile command.
 */
fun compileCommand(compiler: String?, workingDirectory: String?, switches: List<String>, file: String): CompileCommand {
    val directory = workingDirectory ?: file.substringBeforeLast('/', missingDelimiterValue = ".")
    val program = compiler ?: if (file.endsWith(".c")) "cc" else "c++"
    return CompileCommand(directory, file, listOf(program) + switches + file)
}
