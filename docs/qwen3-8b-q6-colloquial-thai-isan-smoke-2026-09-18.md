# Qwen3 8B Q6 — Thai/Isan colloquial smoke check

Run date: 2026-09-18  
Model: `qwen3:8b-q6` on local LAN Ollama  
Data: isolated in-memory SQLite only; a synthetic station-1 person named `สมชาย บ้านดุง`, one recorded visit, and one positive urine result. No real registry account or data was used.

## Results

| Question style | Result |
| --- | --- |
| `สมชาย บ้านดุง คนที่เคยฉี่ม่วงอะ ช่วงนี้ไปหามันกี่รอบแล้ว ล่าสุดยังม่วงอยู่บ่` | Passed: returned visit count and latest urine result from the synthetic records. |
| `เบิ่งประวัติของสมชาย บ้านดุงให้แหน่` | Passed: resolved the person and returned recorded visit history. |
| `พี่สมชาย บ้านดุง ไปหาเขาจักเทื่อแล้ว ผลฉี่หนล่าสุดเป็นจั่งได๋` | Passed: returned visit count and latest urine result. |
| `สมชาย บ้านดุง เยี่ยมล่าสุดมื้อได๋` | Passed: returned the recorded latest-visit date and result. |
| `สมชายบ้านดุงคนที่เคยฉี่ม่วงอะ ช่วงนี้ไปหามันกี่รอบแล้ว ล่าสุดยังม่วงอยู่บ่` | Failed closed: Ollama returned malformed Intent JSON. The router made no database call. |
| `คนที่เคยฉี่ม่วงอยู่บ้านดุงมีไผแน่` | Safe but incorrect: it was recognized as a historical-positive population search, but `บ้านดุง` was emitted as a station filter and produced an empty result instead of being interpreted as a district/location hint. |

## Conclusion

The spaced Thai/Isan formulations work for individual factual queries. The two remaining language issues are bounded and safe: malformed model JSON fails closed, and ambiguous location wording narrows to an empty scoped result rather than broadening access. The next language recovery should address no-space name/place segmentation and normalized mapping of place hints to supported location fields, while preserving authenticated station scope.
