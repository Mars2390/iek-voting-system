# Landing page images

These are the real photos used on `engineer-hub.html`. The page references
optimized copies in `optimized/` (resized + compressed with sharp — originals
here are untouched, full-resolution).

| File | Used in |
|---|---|
| `pexels-dextarstudio-15483316.jpg` | Hero frame |
| `pexels-shvetsa-5324972.jpg` | "Build your profile" card |
| `pexels-thisisengineering-19895882.jpg` | "Search the directory" card |
| `pexels-mikael-blomkvist-8961146.jpg` | "Connect" card |
| `pexels-shameer-vayalakkad-hydrose-2602409-21812146.jpg` | "Get verified" card |
| `pexels-alexquezada-33041841.jpg` | Gallery — Electrical & Power |
| `pexels-aron-razif-98492360-9336590.jpg` | Gallery — Oil & Gas / Process |
| `pexels-atmadeep-das-1776637129-28247164.jpg` | Gallery — Marine Engineering |
| `pexels-clickerhappy-633850.jpg` | Gallery — Mechanical Engineering |
| `pexels-e-g-439660199-29155807.jpg` | Gallery — Power & Energy |
| `pexels-harrun-muhammad-116282236-37198875.jpg` | Gallery — Civil & Structural |

Not currently used: `pexels-aron-razif-98492360-9336587.jpg` (near-duplicate of
the platform shot above), `pexels-dothanhyb-5530437.jpg` (school computer lab —
not visually engineering-specific), `pexels-saruhan-osmanoglu-333083161-37430039.jpg`
(offshore vessel at sunset), `pexels-thisisengineering-3861946.jpg` (designer with
component). All still here if you want to swap any of the six gallery slots later.

To swap an image: replace the file in `optimized/` (or re-run the resize step
against a new original) — the `<img src>` paths in `engineer-hub.html` point
directly at filenames in `optimized/`.
