# ThaniPitak image UI

`index.html` is the Thai image-generation page served by `qwen-draw.service` at
`https://image.policeshield4.com/`. Its logo is a 240 px JPEG derived from the
owner-provided `THANI PITAK.png` and embedded in the HTML, so the existing
standard-library Python server needs no static-file route.

`draw_server.py` implements the local API. The live files are in
`/home/ekkaphap/draw-server/` on `ake-server`. The server reads HTML for every
page request, so an atomic HTML replacement requires no restart. A Python
change requires a `qwen-draw.service` restart. Preserve the asynchronous
`/api/generate`, `/api/status/<id>`, and `/api/image/<id>` contract.

The default auto profile uses 25 Euler/simple steps and CFG 1 for general
prompts, matching the [official ComfyUI Qwen-Image-2.1 template](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_2_1_t2i.json).
Prompts requesting visible text, explicit negative prompts, and manually
selected quality mode use 20 steps and CFG 2.5. At 768 px with the same Thai
scene prompt and seed on this RTX 3060, the old path took 98 seconds and the
fast path took 54 seconds. In one Thai signage comparison, the quality path
rendered the requested headline more faithfully. These are single-image
observations, not a general quality guarantee.

Two fixed-seed 768 px trials on a fictional portrait did not fix a left-hand
book/right-hand-on-table request: both a generic composition reminder and a
specific hand-placement reminder still placed both hands on the book. The
generic reminder also shifted the apparent age. No automatic prompt rewrite
or sampler change was deployed from these trials.

Run `python -m unittest discover -s tests -p test_draw_server.py` locally
before deploying the Python file. Run `npm test` for routing changes.

The ComfyUI server, model files, generated images, tunnel token, and service
configuration are separate from these tracked files. Do not add them to Git.
