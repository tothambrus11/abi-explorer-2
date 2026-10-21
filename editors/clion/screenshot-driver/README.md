# CLion plugin screenshots and demo GIF

A driver plugin that CLion runs next to ABI Explorer, on `sample/` (a CMake project). It waits
for the plugin's warning, then drives the IDE with the mouse and keyboard, so leave them alone
while it runs, and keep the screen from locking: captures of a locked screen come out black.

```sh
cd editors && npm ci && npm run build
cd clion && ./gradlew buildPlugin
cd screenshot-driver
../gradlew runIde                                   # stills: build/screenshots/clion-*.png
../gradlew runIde -Pscene=demo                      # the README's GIF, as frames in build/screenshots/demo
python3 make-gif.py build/screenshots/demo ../media/demo.gif --start 1000
```

`-PscreenshotIde="/path/to/CLion"` runs an installed CLion (its licence too) instead of the
2025.3.1 Gradle downloads (a CLion EAP works too, signed in to a JetBrains Account; on a headless
Linux box run it under `Xvfb :99 -screen 0 1920x1080x24` with `DISPLAY=:99`, as root if need be); `-Pzoom=1.75` zooms the IDE further for the demo (1.5 by default).
The **stills** hover `struct Packet` and a member in `main.cpp`, show quick documentation, the
intentions and the Struct Layout tool window. The **demo** opens the Struct Layout tool window
beside `demo.cpp`, hovers `struct Message`, applies **Reorder members by alignment** with
`Alt+Enter`, and hovers a use of it. `make-gif.py` (Pillow and ffmpeg) crops the frames to the
editor and the tool window and draws the mouse, which screen captures leave out. `driver.log` says which CLion ran, what the driver waited for and which dialogs it
accepted; `-Dabiexplorer.screenshots.stay` in `jvmArgs` keeps CLion open afterwards.
