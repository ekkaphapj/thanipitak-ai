# ThaniPitak image UI

`index.html` and `draw_server.py` serve `https://image.policeshield4.com/` through
`qwen-draw.service` on the Ubuntu pilot. The live checkout is
`/home/ekkaphap/draw-server/`. ComfyUI runs separately on loopback port 8188.
The page keeps its owner-provided logo embedded in HTML.

The UI loads `GET /api/models` and submits an allowlisted `model` id with
`POST /api/generate`. The legacy default remains `qwen-image-2.1` when an old
client omits `model`. The endpoint returns the selected model with the job id;
`GET /api/status/<id>` also includes it. Model availability is checked from
installed files. An unknown model, unsupported option, or unavailable model
fails explicitly before queueing. Raw model filenames from requests are never
used to build a graph.

| Model id | ComfyUI path | Profiles | Reference | Negative |
|---|---|---|---|---|
| `qwen-image-2.1` | Qwen-Image-2.1 Q4 GGUF | fast 16/CFG 1, medium 25/CFG 1, quality 30/CFG 2.5 | Yes | Quality profile only |
| `flux.2-klein-4b` | FLUX.2 [klein] 4B FP8 distilled | standard 4-step/CFG 1 | Not in this UI | No |

The FLUX graph follows [ComfyUI's distilled 4B workflow](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_flux2_klein_text_to_image.json).
The FP8 diffusion file is published by Black Forest Labs for this model and
fits the 12 GB RTX 3060 more comfortably than BF16. The three model files are
installed under `~/ComfyUI/models/` and are **not** committed:

- `diffusion_models/flux-2-klein-4b-fp8.safetensors` from
  `black-forest-labs/FLUX.2-klein-4b-fp8`
- `text_encoders/qwen_3_4b.safetensors` from `Comfy-Org/flux2-klein`
- `vae/flux2-vae.safetensors` from `Comfy-Org/flux2-dev`

To add another model, define one allowlisted entry in `MODELS`, provide its
graph builder in `build_graph`, declare supported profiles and features, and
add routing tests. The UI reads the catalog and hides unsupported controls.
This is intentional: installing a weight file alone must not grant clients a
way to request arbitrary ComfyUI nodes or filenames.

`index.html` is re-read per request. A Python change needs a `qwen-draw.service`
restart; newly installed ComfyUI model files also need a `comfyui.service`
restart to refresh loader lists. Preserve the asynchronous generate/status/image
contract so requests remain shorter than the Cloudflare edge timeout. Do not
commit generated images, model weights, uploaded references, or service tokens.

Validation:

```powershell
python -m unittest discover -s tests -p test_draw_server.py
npm test
```
