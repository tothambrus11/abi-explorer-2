// The plugin's logic that needs no IDE: which Node.js to run, compile commands
// from CLion's compiler settings, the panel page. A build of its own, so it
// compiles and tests without the IntelliJ Platform (and its repositories).
plugins {
    kotlin("jvm") version "2.4.21"
}

group = "abiexplorer"
version = "0.2.0"

repositories {
    mavenCentral()
}

kotlin {
    jvmToolchain(21)
}

dependencies {
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:6.1.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
}
