"""Focused checks for the separate ComfyUI draw service."""
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy" / "draw-server"))
import draw_server


class DrawProfilesTest(unittest.TestCase):
    def test_auto_profile_keeps_general_prompts_fast_and_text_prompts_precise(self):
        self.assertEqual(draw_server.choose_profile("นกสีฟ้าเกาะกิ่งไม้", ""), "fast")
        self.assertEqual(draw_server.choose_profile('ป้ายเขียนว่า "กาแฟสด"', ""), "quality")
        self.assertEqual(draw_server.choose_profile("ใส่คำว่าธานีพิทักษ์บนป้าย", ""), "quality")
        self.assertEqual(draw_server.choose_profile("blue bird", "watermark"), "quality")
        self.assertEqual(draw_server.choose_profile("blue bird", "", "quality"), "quality")

    def test_graph_uses_measured_sampler_profiles(self):
        fast = draw_server.build_graph("blue bird", "", 768, 123)
        quality = draw_server.build_graph('ป้ายเขียนว่า "กาแฟสด"', "", 768, 123)
        self.assertEqual((fast["4"]["inputs"]["steps"], fast["4"]["inputs"]["cfg"]), (25, 1.0))
        self.assertEqual((quality["4"]["inputs"]["steps"], quality["4"]["inputs"]["cfg"]), (20, 2.5))
        self.assertEqual(fast["3"]["inputs"]["resolution"], 768)
        self.assertEqual(fast["4"]["inputs"]["latent_image"], ["3", 2])


class DrawHttpTest(unittest.TestCase):
    def setUp(self):
        draw_server.JOBS.clear()
        self.server = draw_server.ThreadingHTTPServer(("127.0.0.1", 0), draw_server.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api/generate"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        draw_server.JOBS.clear()

    def post(self, body):
        request = urllib.request.Request(
            self.url, body, {"Content-Type": "application/json"}, method="POST"
        )
        return urllib.request.urlopen(request, timeout=2)

    def test_api_reports_selected_profile_without_running_comfy(self):
        with mock.patch.object(draw_server, "run_job"):
            with self.post(json.dumps({"prompt": "blue bird", "resolution": 768}).encode()) as r:
                self.assertEqual(json.load(r)["profile"], "fast")
            with self.post(json.dumps({"prompt": 'ป้ายเขียนว่า "กาแฟสด"'}).encode()) as r:
                self.assertEqual(json.load(r)["profile"], "quality")

    def test_invalid_utf8_and_profile_are_rejected(self):
        for body in (b'{"prompt":"\xff"}', b'{"prompt":"bird","profile":"invalid"}'):
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.post(body)
            self.assertEqual(error.exception.code, 400)
            error.exception.close()


if __name__ == "__main__":
    unittest.main()
