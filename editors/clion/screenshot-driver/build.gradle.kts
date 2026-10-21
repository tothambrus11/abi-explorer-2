// Screenshots of the CLion plugin: `./gradlew buildPlugin` in editors/clion
// first, then `../gradlew runIde` here. CLion opens sample/ with the plugin
// and this driver, which hovers, opens the tool window and saves PNGs to
// build/screenshots, then quits. See README.md.
plugins {
    kotlin("jvm") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "abiexplorer"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

kotlin {
    jvmToolchain(21)
}

val pluginZip = fileTree("../build/distributions") { include("*.zip") }

dependencies {
    intellijPlatform {
        // -PscreenshotIde=/path/to/CLion runs an installed CLion (its licence too).
        val installed = providers.gradleProperty("screenshotIde").orNull
        if (installed != null) local(installed) else clion("2025.3.1")
        localPlugin(pluginZip.singleFile)
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "253.28295"
            untilBuild = provider { null }
        }
    }
    buildSearchableOptions = false
}

val sampleCopy = layout.buildDirectory.dir("sample")
val syncSample by tasks.registering(Sync::class) {
    from("sample")
    into(sampleCopy)
}

tasks.runIde {
    // A fresh copy each run (Sync drops the .idea of the last), so CLion loads it as a new CMake project.
    dependsOn(syncSample)
    args(sampleCopy.get().asFile.absolutePath)
    jvmArgs(
        "-Dabiexplorer.screenshots.scene=${providers.gradleProperty("scene").getOrElse("stills")}",
        "-Dabiexplorer.screenshots.zoom=${providers.gradleProperty("zoom").getOrElse("1.5")}",
        "-Dabiexplorer.screenshots.out=${layout.buildDirectory.dir("screenshots").get().asFile.absolutePath}",
        "-Didea.trust.all.projects=true",
        "-Dide.show.tips.on.startup.default.value=false",
        "-Didea.initially.ask.config=never",
        "-Djb.consents.confirmation.enabled=false",
        "-Djb.privacy.policy.text=<!--999.999-->",
        "-Dide.browser.jcef.sandbox.enable=false",
    )
}
