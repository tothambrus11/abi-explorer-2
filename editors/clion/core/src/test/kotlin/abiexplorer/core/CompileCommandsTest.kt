package abiexplorer.core

import kotlin.test.Test
import kotlin.test.assertEquals

class CompileCommandsTest {
    @Test
    fun `puts compiler, switches and file in order`() {
        assertEquals(
            CompileCommand("/p/build", "/p/src/a.cpp", listOf("/usr/bin/g++", "-std=c++20", "-I/p/include", "/p/src/a.cpp")),
            compileCommand("/usr/bin/g++", "/p/build", listOf("-std=c++20", "-I/p/include"), "/p/src/a.cpp"),
        )
    }

    @Test
    fun `falls back to the file's directory and a generic compiler`() {
        assertEquals(
            CompileCommand("/p/src", "/p/src/a.c", listOf("cc", "/p/src/a.c")),
            compileCommand(null, null, emptyList(), "/p/src/a.c"),
        )
    }
}
