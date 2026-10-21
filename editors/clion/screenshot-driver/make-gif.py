#!/usr/bin/env python3
"""The README's GIF from the frames the demo scene records (build/screenshots/demo).

    python3 make-gif.py build/screenshots/demo ../media/demo.gif [--width 1200]

Crops each frame to the editor, draws the mouse cursor where frames.tsv says it was
(screen captures leave it out), and writes the GIF with ffmpeg, each frame shown as long
as it was on screen. Needs Pillow and ffmpeg.
"""
import argparse
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

# An arrow cursor, in points of a 1x screen: tip at (0, 0).
ARROW = [(0, 0), (0, 17), (4.5, 13), (7.5, 19.5), (10, 18.5), (7, 12), (12.5, 12)]


def cursor(image, x, y, scale):
    draw = ImageDraw.Draw(image)
    points = [(x + px * scale, y + py * scale) for px, py in ARROW]
    draw.polygon(points, fill="white", outline="black", width=max(1, round(scale)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("frames", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--width", type=int, help="scale the GIF to this width")
    parser.add_argument("--margin", type=int, default=0, help="pixels to keep around the editor")
    parser.add_argument("--cursor", type=float, default=1.4, help="the cursor's size, against the screen's own")
    parser.add_argument("--start", type=int, default=0, help="leave out the first this many milliseconds")
    parser.add_argument("--fps", type=int, default=15, help="at most this many frames a second")
    args = parser.parse_args()

    bounds = {}
    for line in (args.frames / "bounds.tsv").read_text().splitlines():
        name, *values = line.split("\t")
        bounds[name] = [int(v) for v in values]
    frame_w, _ = bounds["frame"]
    rows = [line.split("\t") for line in (args.frames / "frames.tsv").read_text().splitlines()[1:]]
    rows = [(int(ms) - args.start, int(frame), int(x), int(y)) for ms, frame, x, y in rows if int(ms) >= args.start]

    first = Image.open(args.frames / "frame-0001.png")
    ratio = first.width / frame_w  # screen pixels per point
    # The editor, and the Struct Layout panel beside it when the recording has one.
    shown = [bounds[name] for name in ("editor", "panel") if name in bounds]
    left = min(x for x, _, _, _ in shown)
    top = min(y for _, y, _, _ in shown)
    right = max(x + w for x, _, w, _ in shown)
    bottom = max(y + h for _, y, _, h in shown)
    m = args.margin
    box = (
        max(0, round(left * ratio) - m), max(0, round(top * ratio) - m),
        min(first.width, round(right * ratio) + m), min(first.height, round(bottom * ratio) + m),
    )

    # Merge rows that show the same picture, and keep to the frame rate.
    shots = []  # [start ms, frame, x, y]
    for ms, frame, x, y in rows:
        if shots and shots[-1][1:] == [frame, x, y]:
            continue
        if shots and ms - shots[-1][0] < 1000 / args.fps:
            shots[-1][1:] = [frame, x, y]
        else:
            shots.append([ms, frame, x, y])
    end = rows[-1][0] + 1500

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        lines = []
        for i, (ms, frame, x, y) in enumerate(shots):
            image = Image.open(args.frames / f"frame-{frame:04d}.png").convert("RGB")
            cursor(image, x, y, ratio * args.cursor)
            image = image.crop(box)
            if args.width:
                image = image.resize((args.width, round(image.height * args.width / image.width)), Image.LANCZOS)
            path = tmp / f"{i:05d}.png"
            image.save(path)
            duration = ((shots[i + 1][0] if i + 1 < len(shots) else end) - ms) / 1000
            lines += [f"file '{path}'", f"duration {duration:.3f}"]
        lines.append(f"file '{tmp / f'{len(shots) - 1:05d}.png'}'")
        (tmp / "list.txt").write_text("\n".join(lines) + "\n")
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(tmp / "list.txt"),
                "-vf", "split[a][b];[a]palettegen=stats_mode=full:max_colors=256[p];[b][p]paletteuse=dither=none",
                "-vsync", "vfr", str(args.output),
            ],
            check=True,
        )
    print(f"{args.output}: {len(shots)} frames, {box[2] - box[0]}x{box[3] - box[1]} cropped")


if __name__ == "__main__":
    main()
