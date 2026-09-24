# ThaniPitak image UI

`index.html` is the Thai image-generation page served by `qwen-draw.service` at
`https://image.policeshield4.com/`. Its logo is a 240 px JPEG derived from the
owner-provided `THANI PITAK.png` and embedded in the HTML, so the existing
standard-library Python server needs no static-file route.

The live file is `/home/ekkaphap/draw-server/index.html` on `ake-server`.
The server reads it for every page request, so an atomic replacement deploys a
UI-only change without restarting the service. Keep the existing `/api/generate`,
`/api/status/<id>`, and `/api/image/<id>` contracts intact.

The ComfyUI server, model files, generated images, tunnel token, and service
configuration are separate from this tracked UI file. Do not add them to Git.
