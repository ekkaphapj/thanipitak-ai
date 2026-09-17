# บันทึกศึกษาโค้ดธานีพิทักษ์และ Local AI

ตรวจเมื่อ 17 กันยายน 2026 เพื่อใช้พัฒนาต่อ ไม่ได้แก้ source code หรือเชื่อมฐานข้อมูลจริง

## เวอร์ชันที่ตรวจ

| Repository | Checkout ในเครื่อง | สถานะเทียบ GitHub |
| --- | --- | --- |
| ekkaphapj/thanipitak-ai | E:/Projects/Thanipitak-sandbox | branch `phase-3.3-low-latency`, HEAD `3a18f58`, นำ `origin/main` (`c4ee527`) 2 commits |
| ekkaphapj/udonpolice-datacenter | E:/Projects/ThaniPitak/udonpolice-datacenter | HEAD `81b44bd`, ตาม `origin/main` (`b1303e2`) 71 commits |

ใช้ git fetch เพื่อตรวจ remote โดยไม่ได้ checkout, merge, reset หรือ pull ทับงานเดิม ระบบหลักตรวจทั้ง checkout และไฟล์สำคัญจาก origin/main โดยตรง

AI มีงานเดิมที่ยังไม่ commit: frontend/ai.css, frontend/ai.js, src/ai/gateway.js, src/ai/personFastPath.js, src/ai/toolRouter.js, src/routes/aiRoutes.js และไฟล์ใหม่ personNameResolver.js, personAnalyzer.js, tests/personNameResolution.test.js, tests/personAnalysis.test.js, scripts/benchmark-step4.js รวมทั้ง tmp scripts สองไฟล์

## โครงสร้างระบบหลัก

- React 18 + TypeScript + Vite, React Router, TanStack Query, shadcn/ui และ Tailwind
- Supabase เป็น Auth, PostgreSQL, RPC/RLS และ Edge Functions
- `src/App.tsx`: route และโมดูลต่าง ๆ
- `src/contexts/AuthContext.tsx`: Supabase session และโหลด profile จาก users โดย auth_id
- `src/integrations/supabase/types.ts`: โครงสร้างข้อมูลที่ generate ไว้; ต้องตรวจ migrations ประกอบ ไม่ถือว่าไฟล์นี้ครอบคลุม schema ล่าสุดทั้งหมด
- `src/lib/externalUserPermissions.ts`, `stationUtils.ts` และ migrations: สิทธิ์ตามบทบาท สถานี จังหวัด และสังกัด
- `supabase/functions`: จัดการผู้ใช้ ลงทะเบียน ผู้ดูแลบุคคล และ upload เป็นต้น

โมดูลปัจจุบันบน remote มีบุคคล การเยี่ยม ผู้เสพ/ผู้ค้า/จิตเวช ผู้ดูแล คดี การติดตามผู้พ้นโทษ และหนึ่งตำรวจหนึ่งหมู่บ้าน ขอบเขตกว้างกว่า sandbox

ค้นใน src/pages, src/lib, src/contexts และ supabase/functions ของ origin/main ยังไม่พบ reference ตรงไปยัง Ollama, /api/ai, localhost:3100 หรือ thanipitak-ai จึงยังไม่พบตัวเชื่อม Local AI ในบริเวณที่ตรวจ

## โครงสร้าง AI

- Node >=22.5, CommonJS, Express, node:sqlite, bcryptjs, jsonwebtoken
- `src/app.js`: REST API /api/auth, /api/persons, /api/statistics, /api/followups, /api/ai, /api/admin และ static frontend
- `src/config.js`: ค่าเริ่มต้น port 3100, SQLite data/thanipitak.db และ JWT config
- `src/routes/aiRoutes.js`: POST /api/ai/chat รับ message และ context.personId; ปฏิเสธ field เช่น role, station_id, sql จาก frontend; บันทึก audit
- `src/ai/gateway.js`: เลือกเส้นทางตอบและเรียก Ollama ค่าเริ่มต้น http://127.0.0.1:11434, model qwen3.5:9b
- `src/ai/toolRouter.js`: tool allowlist 6 ตัว ได้แก่ get_statistics, search_persons, get_person_detail, get_visit_history, get_urine_history, get_overdue_followups
- `src/services/personService.js`: ตัดสินสิทธิ์จาก backend user และสร้าง person summary
- `src/repositories/personRepo.js`: SQL แบบ parameterized
- `frontend/ai.js`, `frontend/chatContext.js`: แชต การเลือกบุคคล การแสดงผลแบบมีโครงสร้าง; context เป็นเพียง hint และต้องตรวจสิทธิ์ซ้ำบน backend

ลำดับใน gateway ของ working tree:

1. Tier 2 selected-person factual: มี personId และคำถามเข้าเงื่อนไข → สรุปข้อมูลโดยตรง ไม่เรียก Ollama
2. Tier 2 explicit name: ค้นชื่อในพื้นที่ → ไม่พบ / พบคนเดียว / ชื่อซ้ำให้เลือก → ตอบข้อเท็จจริงโดยตรง
3. Tier 3 one-shot analysis: ระบุตัวบุคคลก่อน → โหลด summary ที่ตรวจสิทธิ์แล้ว → ส่ง fact packet ที่เลือก field และตัด note → เรียก Ollama หนึ่งครั้ง
4. Tier 1 count/list: คำถามจำนวนหรือรายชื่อที่ตรงเงื่อนไข → ตอบจาก DB
5. Fallback: Ollama tool loop สูงสุด 5 iterations ต่อ loop; ถ้าเป็น DB intent แต่โมเดลไม่ใช้ tool มี retry อีกหนึ่ง loop

ระบบนี้เป็น structured-data tool calling + deterministic routing ยังไม่พบ vector database/embedding RAG ในโค้ดที่ตรวจ และ fallback ส่ง system + คำถามปัจจุบัน ไม่ได้ส่งประวัติแชตเต็ม

## ช่องว่างก่อนเชื่อมระบบหลัก

| หัวข้อ | ระบบหลัก | AI sandbox |
| --- | --- | --- |
| บุคคล | people, type_id → people_type | persons, person_type enum 3 ค่า |
| ที่อยู่ | amphoe, tambon, province | district, subdistrict |
| สถานะ | status และ custody_status; domain rules ในระบบหลัก | registered/active/followup/completed |
| Auth | Supabase session + users.auth_id/profile | JWT ที่ sandbox ออกเอง |
| สิทธิ์ | Admin/User/External/SuperAdmin และขอบเขตหลายระดับ | admin เห็นทั้งหมด, officer/viewer จำกัด stationId |
| การเยี่ยม/ตรวจ | ต้อง map ตาม schema และ migrations จริง | visits และ urine_tests แยกตาราง |

ต้องออกแบบ data adapter และ auth adapter โดยยึดสิทธิ์จริงของระบบหลัก ไม่ควร map Admin ทุกประเภทเป็น sandbox admin เพราะจะกลายเป็นสิทธิ์เห็นทุกสถานี ใช้ person ID จากแหล่งข้อมูลที่กำหนดชัดเจน ป้องกันการชนกันระหว่าง ID ของข้อมูลจำลองและข้อมูลจริง

## ข้อค้นพบเพื่อแก้ต่อ

1. **ยืนยันแล้ว: ผู้ใช้ไม่มีสถานีอาจได้รายชื่อทุกสถานี** — allowedStationIds ส่ง [] แต่ personRepo.buildFilter เพิ่มเงื่อนไข station เฉพาะ array ที่ length > 0 ทำให้ [] กลายเป็น query ไม่จำกัดพื้นที่ ส่งผลต่อ listPersons/listPersonsWithSummary และการค้นชื่อ ทดสอบด้วย SQLite :memory: สองคนสองสถานี: officer station 1 ได้ 1 คน, officer stationId null ได้ 2 คน (ควรเป็น 0) การอ่าน detail ยังมี hasAccessToPerson อีกชั้น
2. **เกณฑ์ติดตามไม่ตรงกัน** — statisticService.followupOverdue ใช้ 30 วันทุกประเภท แต่ followupService และ person summary ใช้ psychiatric 30, drug_user 60, dealer 15 วัน จึงอาจได้ยอดสถิติกับรายชื่อคนละจำนวน
3. **grounded ไม่ใช่การตรวจทุกข้อเท็จจริงในคำตอบ** — fallback ถือว่าการใช้ tool ที่อยู่ใน allowlist เพียงพอ แม้ผล tool เป็น error; one-shot ตั้ง grounded=true หลังส่ง fact packet ไม่มีตัวตรวจ output รายข้อ เทสต์ผ่านจึงยังไม่ยืนยันว่า LLM ไม่แต่งคำตอบ
4. **ค้นชื่อจำกัด 100 แถวก่อนกรอง exact match** — อาจรายงานไม่พบหรือพบคนเดียวทั้งที่มีรายการตรงกันนอกหน้าแรก ต้องย้าย exact matching ไป query หรือจัดการ pagination/ความไม่ครบถ้วน
5. **การตั้งค่าสำหรับใช้งานจริงยังต้องปรับ** — มี fallback JWT secret, bind 0.0.0.0 และ CORS เปิดทั่วไปใน sandbox; auth อ่าน claims จาก JWT โดยไม่ได้โหลด profile ใหม่ทุก request จึงต้องออกแบบเรื่องเปลี่ยนสิทธิ์/ยกเลิกบัญชีร่วมกับระบบหลัก

ข้อ 1 มี reproduction ด้วยข้อมูลสังเคราะห์; ข้ออื่นเป็นผลอ่านโค้ด ไม่ใช่ผลตรวจระบบ production

## การตรวจสอบ

- Node v24.13.1; `npm test`: 209 tests, 25 suites, ผ่านทั้งหมด ไม่มี fail/skip
- เทสต์ใช้ฐานข้อมูลชั่วคราวและ stub/mock ในส่วน AI; ไม่ได้ทดสอบ inference จริงกับ Ollama หรือวัด latency ของโมเดล
- ไม่ได้รัน build/ทดสอบ browser ของระบบหลัก ไม่ได้ยืนยัน RLS ที่ deploy อยู่หรืออ่านข้อมูลบุคคลจริง
- ผลเทสต์เก็บที่ `%TEMP%/thanipitak-study-tests.log`

## ลำดับพัฒนาที่เสนอ

1. แก้ empty station scope ให้ปฏิเสธโดยปริยาย พร้อม regression test และรวมกฎ overdue ให้เป็นจุดเดียว
2. เก็บงาน Phase 3.3 ในเครื่องให้เป็นเวอร์ชันอ้างอิงที่ชัดเจนก่อนรวมงานใหม่
3. กำหนด contract ของข้อมูลและสิทธิ์ระหว่าง Supabase กับ AI โดยครอบคลุมบทบาทจริงและสถานะจริง
4. เพิ่ม adapter อ่านข้อมูลที่ผ่านการตรวจสิทธิ์ และ UI เรียก AI จากระบบหลัก
5. ทดสอบ end-to-end กับ Ollama: ชื่อซ้ำ ข้อมูลข้ามสถานี/จังหวัด การเปลี่ยนสิทธิ์ ข้อมูลไม่ครบ prompt injection ใน note และ latency

รายการนี้เป็นข้อเสนอ ยังไม่ได้ลงมือแก้หรือ deploy
