const express = require('express');
const http = require('http');
const { createToolRouter } = require('../ai/toolRouter');
const { createAIGateway, OLLAMA_MODEL } = require('../ai/gateway');
const { createAIAuditor } = require('../repositories/aiAuditRepo');
const { createRag } = require('../ai/rag');
const path = require('path');

const MAX_MESSAGE_LENGTH = 2000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

const FORBIDDEN_BODY_FIELDS = ['station_id', 'allowedStationIds', 'role', 'user_id', 'tool', 'system_prompt', 'sql'];

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
  const rag = options.rag || createRag({
    knowledgeDir: process.env.RAG_KNOWLEDGE_DIR || path.join(__dirname, '..', '..', 'knowledge'),
    indexPath: process.env.RAG_INDEX_PATH || path.join(__dirname, '..', '..', 'data', 'rag-index.json'),
    ollamaHost: OLLAMA_HOST,
    embedModel: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
  });
  const gateway = options.gateway || createAIGateway(toolRouter, rag);
  const aiAudit = createAIAuditor(db);
  const ollamaCheck = options.ollamaCheck || checkOllamaAvailable;

  router.get('/status', authRequired, async (req, res) => {
    const { available } = await ollamaCheck();
    return res.json({ available, model: OLLAMA_MODEL, rag: rag.status() });
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
    aiAudit.logChat(user);

    const onToolCall = ({ toolName, toolArgs, userId }) => {
      aiAudit.logToolCall({ id: userId }, toolName, toolArgs);
    };

    const startMs = Date.now();
    try {
      const { answer, toolsUsed, grounded, retryCount } = await gateway.chatWithTools(message.trim(), user, onToolCall);

      if (!answer) {
        return res.status(502).json({
          error: 'AI ไม่สามารถตอบได้ในขณะนี้ เนื่องจากถึงขีดจำกัดการเรียก tool',
          code: 'AI_MAX_TOOL_ITERATIONS',
        });
      }

      aiAudit.logReliability(user, { grounded, retryCount, toolsUsed });

      return res.json({
        answer,
        toolsUsed: toolsUsed.map((name) => ({ name })),
        model: OLLAMA_MODEL,
        meta: {
          responseTimeMs: Date.now() - startMs,
          grounded,
          retryCount: retryCount || 0,
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
