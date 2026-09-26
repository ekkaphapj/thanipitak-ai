'use strict';

// Deterministic self-introduction. The wording below is owner-specified, so
// the assistant answers identically whether the command is typed or spoken and
// no model call is spent on it. Never extend this text with facts that are not
// already in it.
const INTRODUCTION_TEXT = 'สวัสดีค่ะ ดิฉันคือ ผู้ช่วยเอไอ ธานีพิทักษ์ ถูกพัฒนาขึ้นเพื่อเป็นผู้ช่วยในการค้นหาข้อมูลด้านต่างๆ การสั่งงานสามารถพิมพ์คำสั่ง หรือ สั่งงานด้วยเสียงได้เลยนะคะ การสั่งงานด้วยเสียง สามารถกดปุ่มค้างไว้ แล้วพูดคำสั่งช้าๆชัดๆได้เลยนะคะ สำหรับการใช้งานสามารถพิมพ์หรือพูดได้เลยว่า สอนใช้งานหน่อย/ใช้งานยังไง แล้วทำแบบฝึกฝนได้เลยค่ะ หากมีข้อบกพร่อง หรือข้อเสนอแนะอะไร สามารถติดต่อผู้พัฒนาได้เลยนะคะ ขอบคุณค่ะ';

// Matches the introduction commands: คุณคือใคร / เธอคือใคร, ช่วยแนะนำตัวหน่อย,
// แนะนำตัวด้วย, แนะนำตัวให้ฟัง, … Run on the normalized utterance (politeness
// particles already stripped by normalizeUtterance). The แนะนำตัว branch is
// end-anchored so phrases like “หาคนแนะนำตัวยา” never match.
const INTRODUCTION_RE = /(?:คุณ|เธอ|นาย|หนู)\s*คือใคร|(?:ช่วย\s*)?แนะนำ\s*ตัว(?:เอง)?(?:\s*(?:หน่อย|ด้วย|ให้(?:\s*(?:ฟัง|หน่อย))?))*$/u;

function isIntroductionRequest(message) {
  return INTRODUCTION_RE.test(String(message || '').replace(/\s+/g, ' '));
}

module.exports = { isIntroductionRequest, INTRODUCTION_TEXT };
