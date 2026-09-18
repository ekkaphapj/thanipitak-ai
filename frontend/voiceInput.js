(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VoiceInput = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_SECONDS = 45;
  const MAX_CHARS = 2000;

  function applyTranscript(currentValue, text) {
    const t = String(text || '').trim().slice(0, MAX_CHARS);
    if (!t) return String(currentValue || '');
    const cur = String(currentValue || '').trim();
    const next = cur ? cur + ' ' + t : t;
    return next.slice(0, MAX_CHARS);
  }

  function micErrorMessage(code, status) {
    const map = {
      INSECURE_CONTEXT: 'เบราว์เซอร์นี้ยังใช้ไมโครโฟนไม่ได้ กรุณาเปิดผ่าน localhost หรือ HTTPS แล้วพิมพ์แทน',
      PERMISSION_DENIED: 'ไม่ได้รับอนุญาตใช้ไมโครโฟน กรุณาอนุญาตในเบราว์เซอร์ หรือพิมพ์คำถามแทน',
      STT_UNAVAILABLE: 'ระบบแปลงเสียงในเครื่องยังไม่พร้อม กรุณาพิมพ์คำถามได้ตามปกติ',
      EMPTY_TRANSCRIPT: 'ไม่ได้ยินคำพูด กรุณากดค้างไมค์แล้วพูดใหม่',
      AUDIO_TOO_LARGE: 'ไฟล์เสียงใหญ่เกินกำหนด กรุณาพูดใหม่ให้สั้นลง',
      AUDIO_TOO_LONG: 'เสียงยาวเกิน 45 วินาที กรุณาพูดใหม่ให้สั้นลง',
      STT_BAD_AUDIO: 'แปลงไฟล์เสียงไม่ได้ กรุณาพูดใหม่ หรือติดตั้ง ffmpeg',
      STT_BUSY: 'ระบบกำลังแปลงเสียงคำขออื่นอยู่ กรุณารอแล้วพูดใหม่',
      STT_RATE_LIMITED: 'ขอแปลงเสียงถี่เกินไป กรุณารอสักครู่แล้วพูดใหม่',
      STT_TIMEOUT: 'แปลงเสียงใช้เวลานานเกินไป กรุณาพูดใหม่ให้สั้นลง หรือพิมพ์แทน',
      STT_LOW_CONFIDENCE: 'ฟังเสียงไม่ชัดพอ กรุณาพูดใหม่อีกครั้งให้ชัดและใกล้ไมโครโฟน',
      MISSING_AUDIO: 'กรุณาส่งไฟล์เสียง',
      UNSUPPORTED_AUDIO: 'ชนิดไฟล์เสียงนี้ยังไม่รองรับ',
    };
    if (status === 401) return 'กรุณาเข้าสู่ระบบใหม่';
    return map[code] || 'เกิดข้อผิดพลาด กรุณาลองใหม่';
  }

  function clampSeconds(ms) {
    return Math.min(MAX_SECONDS * 1000, Math.max(0, Number(ms) || 0));
  }

  return { applyTranscript, micErrorMessage, clampSeconds, MAX_SECONDS };
});
