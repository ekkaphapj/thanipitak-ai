const express = require('express');
const http = require('http');
const { createToolRouter } = require('../ai/toolRouter');
const { createAIGateway, OLLAMA_MODEL } = require('../ai/gateway');
const { createAIAuditor } = require('../repositories/aiAuditRepo');
const { sanitizePersonContext } = require('../ai/personFastPath');

const MAX_MESSAGE_LENGTH = 2000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

const FORBIDDEN_BODY_FIELDS = ['station_id', 'allowedStationIds', 'role', 'user_id', 'province_id', 'permissions', 'tool', 'system_prompt', 'sql'];

function checkOllamaAvailable() {
  return new Promise((resolve) => {
    const url = new URL('/api/tags', OLLAMA_HOST);
    const proto = url.protocol === 'https:' ? require('https') : http;
    const req = proto.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const models = (parsed.models || []).map((m) => m.name || m.model);
          resolve({ available: true, models });
        } catch {
          resolve({ available: true, models: [] });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ available: false, models: [] }); });
    req.on('error', () => resolve({ available: false, models: [] }));
  });
}

function createAIRoutes(db, authRequired, options = {}) {
  const router = express.Router();
  const toolRouter = createToolRouter(db);
  const gateway = options.gateway || createAIGateway(toolRouter);
  const aiAudit = createAIAuditor(db);
  const ollamaCheck = options.ollamaCheck || checkOllamaAvailable;

  router.get('/status', authRequired, async (req, res) => {
    const { available } = await ollamaCheck();
    return res.json({ available, model: OLLAMA_MODEL });
  });

  router.post('/chat', authRequired, async (req, res) => {
    const { message } = req.body || {};
    if (!message || typeof message !== 'string' || message.trim() === '') {
      return res.status(400).json({ error: 'กรุณาส่ง message', code: 'MISSING_MESSAGE' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res
        .status(400)
        .json({ error: `message ยาวเกิน ${MAX_MESSAGE_LENGTH} ตัวอักษร`, code: 'MESSAGE_TOO_LONG' });
    }

    for (const field of FORBIDDEN_BODY_FIELDS) {
      if (req.body[field] !== undefined) {
        return res.status(400).json({
          error: `ไม่อนุญาตให้ส่ง field "${field}" จาก frontend`,
          code: 'FORBIDDEN_FIELD',
        });
      }
    }

    const user = req.user;
    const context = sanitizePersonContext(req.body.context);
    aiAudit.logChat(user);

    const onToolCall = ({ toolName, toolArgs, userId }) => {
      aiAudit.logToolCall({ id: userId }, toolName, toolArgs);
    };

    const startMs = Date.now();
    try {
      const result = await gateway.chatWithTools(message.trim(), user, onToolCall, { context });

      if (!result.answer) {
        return res.status(502).json({
          error: 'AI ไม่สามารถตอบได้ในขณะนี้ เนื่องจากถึงขีดจำกัดการเรียก tool',
          code: 'AI_MAX_TOOL_ITERATIONS',
        });
      }

      aiAudit.logReliability(user, {
        grounded: result.grounded,
        retryCount: result.retryCount,
        toolsUsed: result.toolsUsed,
      });

      if (result.fastPath) {
        aiAudit.logFastPath(user, {
          intent: result.intent,
          tool: result.toolsUsed[0],
          grounded: result.grounded,
          success: true,
        });
      }

      return res.json({
        answer: result.answer,
        toolsUsed: (result.toolsUsed || []).map((name) => ({ name })),
        model: OLLAMA_MODEL,
        grounded: result.grounded,
        executionTier: result.executionTier || null,
        presentation: result.presentation || undefined,
        meta: {
          responseTimeMs: Date.now() - startMs,
          fastPath: !!result.fastPath,
          grounded: result.grounded,
          retryCount: result.retryCount || 0,
          executionTier: result.executionTier || null,
        },
      });
    } catch (err) {
      console.error('[ai] gateway error:', err.message);
      return res.status(502).json({
        error: 'AI service ไม่พร้อมใช้งาน กรุณาลองใหม่อีกครั้ง',
        code: 'AI_UNAVAILABLE',
      });
    }
  });

  return router;
}

module.exports = { createAIRoutes, checkOllamaAvailable };
