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

The optional person helper in `index.html` builds an editable prompt with an
exact count (one to three people), a separate position and pose for each
person, and an explicit no-extra-people clause. This follows [Qwen's prompt
guidance](https://github.com/QwenLM/Qwen-Image-2.1/blob/main/prompt_rewrite/prompts/system_prompt_t2i.txt)
to preserve counts and positions. On one fixed-seed 768 px comparison, the
structured two-person prompt kept the standing/waving and seated poses clearly;
both short and structured prompts produced the right count. A three-person
structured prompt also produced the right count in both sampler profiles.
These checks do not prove an accuracy gain for all prompts or seeds.

The optional adult fine-art figure helper builds an editable, nonsexual prompt
with one fictional adult, a chosen medium, a pose, and lighting. It changes only
the text entered in the existing prompt field. The sampler profile and model
remain unchanged; output fidelity for this genre has not been benchmarked.

Run `python -m unittest discover -s tests -p test_draw_server.py` locally
before deploying the Python file. Run `npm test` for routing changes.

The ComfyUI server, model files, generated images, tunnel token, and service
configuration are separate from these tracked files. Do not add them to Git.
