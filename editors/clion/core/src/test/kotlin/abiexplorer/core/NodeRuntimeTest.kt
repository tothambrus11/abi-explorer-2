package abiexplorer.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NodeRuntimeTest {
    @Test
    fun `reads major versions`() {
        assertEquals(22, NodeRuntime.majorVersion("v22.11.0\n"))
        assertEquals(20, NodeRuntime.majorVersion("20.0.0"))
        assertNull(NodeRuntime.majorVersion("node: command not found"))
    }

    @Test
    fun `accepts Node 20 and later`() {
        assertTrue(NodeRuntime.isSupported("v20.19.0"))
        assertFalse(NodeRuntime.isSupported("v18.20.4"))
        assertFalse(NodeRuntime.isSupported(""))
    }

    @Test
    fun `names the official build for each platform`() {
        val windows = NodeRuntime.distribution("windows", "x64", "v22.1.0")
        assertEquals("node-v22.1.0-win-x64.zip", windows.archiveName)
        assertEquals("https://nodejs.org/dist/v22.1.0/node-v22.1.0-win-x64.zip", windows.url)
        assertEquals("node-v22.1.0-win-x64/node.exe", windows.executable)
        val mac = NodeRuntime.distribution("mac", "arm64", "v22.1.0")
        assertEquals("node-v22.1.0-darwin-arm64.tar.gz", mac.archiveName)
        assertEquals("node-v22.1.0-darwin-arm64/bin/node", mac.executable)
    }

    @Test
    fun `finds an archive's hash in SHASUMS256`() {
        val shasums = """
            ABCDEF01  node-v22.1.0-darwin-arm64.tar.gz
            0123abcd  node-v22.1.0-darwin-arm64.tar.xz
        """.trimIndent()
        assertEquals("abcdef01", NodeRuntime.expectedSha256(shasums, "node-v22.1.0-darwin-arm64.tar.gz"))
        assertNull(NodeRuntime.expectedSha256(shasums, "node-v22.1.0-linux-x64.tar.gz"))
    }
}
