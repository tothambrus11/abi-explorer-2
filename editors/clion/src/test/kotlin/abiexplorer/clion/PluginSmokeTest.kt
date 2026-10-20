package abiexplorer.clion

import abiexplorer.core.compileCommand
import com.intellij.codeInsight.CodeInsightSettings
import com.intellij.ide.plugins.PluginManager
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.openapi.extensions.ExtensionPointName
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.progress.EmptyProgressIndicator
import com.intellij.openapi.wm.ToolWindowEP
import com.intellij.testFramework.LightVirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.jetbrains.cidr.lang.workspace.OCWorkspace
import org.eclipse.lsp4j.ClientCapabilities
import org.eclipse.lsp4j.DidOpenTextDocumentParams
import org.eclipse.lsp4j.HoverParams
import org.eclipse.lsp4j.InitializeParams
import org.eclipse.lsp4j.InitializedParams
import org.eclipse.lsp4j.MessageActionItem
import org.eclipse.lsp4j.MessageParams
import org.eclipse.lsp4j.Position
import org.eclipse.lsp4j.PublishDiagnosticsParams
import org.eclipse.lsp4j.ShowMessageRequestParams
import org.eclipse.lsp4j.TextDocumentIdentifier
import org.eclipse.lsp4j.TextDocumentItem
import org.eclipse.lsp4j.WorkspaceFolder
import org.eclipse.lsp4j.jsonrpc.Launcher
import org.eclipse.lsp4j.jsonrpc.services.JsonNotification
import org.eclipse.lsp4j.services.LanguageClient
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * The plugin in the real IntelliJ Platform of the CLion it is built against:
 * its descriptor loads with its extensions, and the server it carries starts
 * on Node.js through ServerRuntime and answers, over the plugin's own protocol
 * classes, for a file whose command is pushed as CLion's project model pushes it.
 *
 * Needs `npm run build` in editors/ first (the server bundle), Node.js 20+ on
 * PATH or the network to download it, and the engine: ABI_ENGINE_PATH, or the
 * network to download the pinned release.
 */
class PluginSmokeTest : BasePlatformTestCase() {
    fun testPluginLoadsWithItsExtensions() {
        val id = PluginId.getId("org.hylo-lang.abi-explorer")
        assertNotNull("the plugin is installed", PluginManagerCore.getPlugin(id))
        // Installed but not loaded is what a missing dependency looks like.
        assertTrue("the plugin is loaded; the C/C++ engines here: ${engines()}", PluginManagerCore.isLoaded(id))
        println("ABI Explorer smoke test: C/C++ engines ${engines()}")
        // The project model WorkspaceCompileCommands reads, whichever engine is loaded.
        assertNotNull("CLion's project model", OCWorkspace.getInstance(project))

        // The extension point holds beans naming the provider class, or the providers themselves.
        val lspProviders = ExtensionPointName<Any>("com.intellij.platform.lsp.serverSupportProvider").extensionList
        val registered = lspProviders.any { provider ->
            provider is AbiExplorerLspSupport ||
                provider.javaClass.declaredFields.any { field ->
                    field.isAccessible = true
                    field.get(provider) == AbiExplorerLspSupport::class.java.name
                }
        }
        assertTrue("the language server is registered among ${lspProviders.map { it.javaClass.name }}", registered)
        assertTrue("the tool window is registered", ToolWindowEP.EP_NAME.extensionList.any { it.id == "Struct Layout" })
        // The tool window's browser, as the plugin's own class loader sees it: since 2026.1 JCEF is a
        // module the plugin reaches only through its dependency on it.
        val loader = PluginManagerCore.getPlugin(id)!!.pluginClassLoader
        println("ABI Explorer smoke test: plugin class loader ${loader?.javaClass?.name}")
        assertNotNull("JCEF from the plugin", (loader ?: javaClass.classLoader).loadClass("com.intellij.ui.jcef.JBCefApp"))
        assertTrue(
            "the settings page is registered",
            Configurable.PROJECT_CONFIGURABLE.getExtensions(project).any { it.id == "abiexplorer.settings" },
        )
    }

    /** Which of CLion's C/C++ engines this IDE loads, and whether the project model the plugin reads is there. */
    private fun engines(): String {
        fun loaded(id: String) = PluginManagerCore.isLoaded(PluginId.getId(id))
        val workspace = PluginManager.getPluginByClass(OCWorkspace::class.java)?.pluginId
        return "classic ${loaded("com.intellij.cidr.lang")}, Nova ${loaded("org.jetbrains.plugins.clion.radler")}, " +
            "OCWorkspace from $workspace"
    }

    override fun tearDown() {
        // Something bundled turns on the quick documentation popup when the first
        // project opens, and the platform's check would blame this test for it.
        CodeInsightSettings.getInstance().AUTO_POPUP_JAVADOC_INFO = CodeInsightSettings().AUTO_POPUP_JAVADOC_INFO
        super.tearDown()
    }

    fun testCFamilyFilesStartTheServer() {
        for ((name, expected) in listOf("a.cpp" to true, "a.h" to true, "a.c" to true, "a.HPP" to true, "a.txt" to false)) {
            assertTrue(name, isCFamily(LightVirtualFile(name)) == expected)
        }
    }

    fun testBundledServerAnswersOverThePluginsProtocol() {
        val fixture = Path.of(System.getProperty("abiexplorer.fixture"))
        val root = Files.createTempDirectory("abi-explorer-clion")
        fixture.toFile().copyRecursively(root.toFile())
        val main = root.resolve("main.cpp")
        val uri = main.toUri().toString()

        val runtime = ServerRuntime.prepare(EmptyProgressIndicator())
        val process = runtime.commandLine().createProcess()
        val client = RecordingClient()
        val launcher = Launcher.Builder<AbiExplorerServer>()
            .setLocalService(client)
            .setRemoteInterface(AbiExplorerServer::class.java)
            .setInput(process.inputStream)
            .setOutput(process.outputStream)
            .create()
        launcher.startListening()
        val server = launcher.remoteProxy
        try {
            val options = AbiExplorerSettings.of(project).initializationOptions().toMutableMap()
            System.getenv("ABI_ENGINE_PATH")?.let { options["enginePath"] = it }
            server.initialize(
                InitializeParams().apply {
                    processId = ProcessHandle.current().pid().toInt()
                    workspaceFolders = listOf(WorkspaceFolder(root.toUri().toString(), "project"))
                    initializationOptions = options
                    capabilities = ClientCapabilities()
                },
            ).get(60, TimeUnit.SECONDS)
            server.initialized(InitializedParams())

            // What WorkspaceCompileCommands sends for a CMake project's source.
            server.compileCommands(
                CompileCommandsParams(
                    "CLion",
                    listOf(
                        compileCommand(
                            compiler = "c++",
                            workingDirectory = root.resolve("build").toString(),
                            switches = listOf("-I${root.resolve("include")}", "-std=c++20"),
                            file = main.toString(),
                        ),
                    ),
                ),
            )
            server.textDocumentService.didOpen(
                DidOpenTextDocumentParams(TextDocumentItem(uri, "cpp", 1, Files.readString(main))),
            )

            val warnings = client.diagnosticsFor(uri).get(300, TimeUnit.SECONDS)
            assertTrue("the wasted-space warning", warnings.diagnostics.any { it.code?.left == "reorder" })

            val hover = server.textDocumentService.hover(HoverParams(TextDocumentIdentifier(uri), Position(8, 9)))
                .get(60, TimeUnit.SECONDS)
            val markdown = hover.contents.right.value
            assertTrue(markdown, markdown.contains("**struct Packet** · 40 B · align 8"))
            // CLion's quick documentation shows no images, so the map comes as text.
            assertTrue(markdown, markdown.contains("```text") && !markdown.contains("data:image"))

            val layout = server.layout(LayoutParams(TextDocumentId(uri), LspPosition(11, 20))).get(60, TimeUnit.SECONDS)
            val names = layout.getAsJsonArray("records").map { it.asJsonObject["name"].asString }
            assertTrue(names.toString(), "Packet" in names)
            assertEquals("CLion", layout.getAsJsonObject("context")["commandSource"].asString)
            assertTrue("the panel's text copy", layout.toString().contains("checksum"))

            server.shutdown().get(30, TimeUnit.SECONDS)
            server.exit()
        } finally {
            process.destroy()
            root.toFile().deleteRecursively()
        }
    }
}

/** Collects what the server publishes; answers nothing it does not have to. */
class RecordingClient : LanguageClient {
    private val diagnostics = mutableMapOf<String, CompletableFuture<PublishDiagnosticsParams>>()

    @Synchronized
    fun diagnosticsFor(uri: String): CompletableFuture<PublishDiagnosticsParams> =
        diagnostics.getOrPut(uri) { CompletableFuture() }

    override fun publishDiagnostics(params: PublishDiagnosticsParams) {
        if (params.diagnostics.isNotEmpty()) diagnosticsFor(params.uri).complete(params)
    }

    @JsonNotification("abiExplorer/layoutsChanged")
    fun layoutsChanged(@Suppress("UNUSED_PARAMETER") params: Any?) {}

    override fun telemetryEvent(`object`: Any?) {}

    override fun showMessage(messageParams: MessageParams?) {}

    override fun showMessageRequest(requestParams: ShowMessageRequestParams?): CompletableFuture<MessageActionItem> =
        CompletableFuture.completedFuture(null)

    override fun logMessage(message: MessageParams?) {}
}
