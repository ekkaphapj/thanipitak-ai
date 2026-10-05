const express = require('express');
const http = require('http');
const { createToolRouter } = require('../ai/toolRouter');
const {
  createAIGateway,
  willUseLocalAi,
  OLLAMA_MODEL,
  OLLAMA_ROUTING_MODE,
  OLLAMA_INTENT_MODEL,
} = require('../ai/gateway');
const { createAIAuditor } = require('../repositories/aiAuditRepo');
const { sanitizePersonContext } = require('../ai/personFastPath');
const { detectVisitPlanIntent } = require('../ai/visitPlanIntent');
const { detectVisitStatsIntent } = require('../ai/visitStatsIntent');
const chartCommands = require('../../frontend/chartCommands');
const chartPresentation = require('../services/chartPresentation');
const { createUserService } = require('../services/userService');
const { createPersonService } = require('../services/personService');

const MAX_MESSAGE_LENGTH = 2000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

const FORBIDDEN_BODY_FIELDS = ['station_id', 'allowedStationIds', 'role', 'user_id', 'province_id', 'permissions', 'tool', 'system_prompt', 'sql'];

function activeOllamaModel() {
  return OLLAMA_ROUTING_MODE === 'intent' ? OLLAMA_INTENT_MODEL : OLLAMA_MODEL;
}

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
          const wanted = activeOllamaModel();
          const hasModel = models.some((name) => name === wanted || `${name}:latest` === wanted || name === `${wanted}:latest`);
          resolve({ available: hasModel, models });
        } catch {
          resolve({ available: false, models: [] });
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
    // Cloud intent parsing is wired on the real-data route only; say so
    // explicitly so the interface can explain itself in test mode.
    return res.json({ available, model: activeOllamaModel(), routingMode: OLLAMA_ROUTING_MODE, cloudAvailable: false, cloudMode: 'real-only' });
  });

  router.post('/chat/processing', authRequired, (req, res) => {
    const { message } = req.body || {};
    if (!message || typeof message !== 'string' || message.trim() === '') return res.status(400).json({ error: 'กรุณาส่ง message', code: 'MISSING_MESSAGE' });
    if (message.length > MAX_MESSAGE_LENGTH) return res.status(400).json({ error: `message ยาวเกิน ${MAX_MESSAGE_LENGTH} ตัวอักษร`, code: 'MESSAGE_TOO_LONG' });
    for (const field of FORBIDDEN_BODY_FIELDS) if (req.body[field] !== undefined) return res.status(400).json({ error: `ไม่อนุญาตให้ส่ง field "${field}" จาก frontend`, code: 'FORBIDDEN_FIELD' });
    return res.json({ willUseLocalAi: chartCommands.detect(message) ? false : willUseLocalAi(message.trim(), sanitizePersonContext(req.body.context)) });
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
    const chartIntent = chartCommands.detect(message);
    if (chartIntent) {
      const users = createUserService(db);
      const storedUser = users.findById(user.id);
      if (!storedUser) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบใหม่' });
      const profile = users.publicProfile(storedUser);
      if (chartIntent.kind === 'help') return res.json(chartCommands.guide(profile, 'test'));
      // “จังหวัดอื่น” is deliberately incomplete: ask which province and
      // remember the pending question, exactly like the real-data route.
      if (chartIntent.otherProvince) {
        return res.json({
          answer: 'ต้องการแผนภูมิบุคคลเป้าหมายราย สภ. ของจังหวัดใด กรุณาพิมพ์หรือพูดชื่อจังหวัดที่ต้องการ',
          grounded: true, dataSource: 'test',
          conversation: { topic: { pending: { type: 'chart_province', chart_kind: 'people' } } },
          meta: { fastPath: true, ollamaCalls: 0 },
        });
      }
      const persons = createPersonService(db);
      const buildFixtureChart = (spec) => {
        const filters = spec.own ? {} : { province: spec.province };
        const summary = persons.summarizePersons(user, filters);
        const groups = persons.groupByLocation(user, { groupBy: 'station', ...filters });
        if (!spec.own && !summary.total) return null;
        const chart = spec.own
          ? chartPresentation.peopleChart({ rows: [{ station_name: profile.stationName, psychiatric_total: summary.byType.psychiatric || 0, drug_user_total: summary.byType.drug_user || 0, dealer_total: summary.byType.dealer || 0, released_total: summary.byType.released || 0, target_total: summary.total }] }, { own: true, areaLabel: profile.stationName, source: 'test' })
          : { type: 'chart', chartType: 'bar', title: `บุคคลเป้าหมายราย สภ. • จังหวัด${spec.province}`, areaLabel: `จังหวัด${spec.province} (ข้อมูลตามสิทธิ์บัญชี)`, labels: groups.groups.map(g => g.name), values: groups.groups.map(g => g.count), total: summary.total, unit: 'คน', dataSource: 'test', asOf: new Date().toISOString() };
        return { ...chartPresentation.response(chart), conversation: { topic: { report_kind: 'chart', chart_kind: 'people', ...(spec.own ? { chart_own: true } : spec.province ? { province: spec.province } : {}) } } };
      };
      if (chartIntent.own && !profile.stationId) return res.json(chartCommands.guide(profile, 'test'));
      if (chartIntent.kind === 'visits') return res.json({ answer: 'กราฟการตรวจเยี่ยมใช้บันทึกจริง กรุณาเลือกโหมดข้อมูลจริงและเข้าสู่ระบบด้วยบัญชีตำรวจ', grounded: false, dataSource: 'test', code: 'REAL_FEATURE_REQUIRED', meta: { fastPath: true, ollamaCalls: 0 } });
      return res.json(buildFixtureChart(chartIntent));
    }
    // The answer to "ของจังหวัดไหน" is normally just a province name; build the
    // pending fixture chart from it. Anything else is a new request and the
    // pending marker is dropped before the ordinary gateway runs.
    if (context?.topic?.pending?.type === 'chart_province') {
      const stripped = String(message).replace(/^(?:เอา|ขอ|ต้องการ|ดู|แบบ|ที่|ของ)\s*/u, '').replace(/^จังหวัด\s*/u, '').trim();
      if (/^(?:ยกเลิก|เอาไว้ก่อน|ไม่เอา|ไม่|พอ)$/.test(message)) {
        return res.json({ answer: 'ยกเลิกการขอแผนภูมิจังหวัดอื่นแล้ว พิมพ์หรือพูดคำสั่งใหม่ได้เลย', grounded: true, dataSource: 'test', conversation: { topic: null }, meta: { fastPath: true, ollamaCalls: 0 } });
      }
      if (message.length <= 60 && /^[\u0e00-\u0e7f\s]{2,40}$/u.test(stripped)) {
        const users = createUserService(db);
        const storedUser = users.findById(user.id);
        const profile = storedUser ? users.publicProfile(storedUser) : null;
        const persons = createPersonService(db);
        const summary = persons.summarizePersons(user, { province: stripped });
        if (summary.total > 0) {
          const groups = persons.groupByLocation(user, { groupBy: 'station', province: stripped });
          const chart = { type: 'chart', chartType: 'bar', title: `บุคคลเป้าหมายราย สภ. • จังหวัด${stripped}`, areaLabel: `จังหวัด${stripped} (ข้อมูลตามสิทธิ์บัญชี)`, labels: groups.groups.map(g => g.name), values: groups.groups.map(g => g.count), total: summary.total, unit: 'คน', dataSource: 'test', asOf: new Date().toISOString() };
          return res.json({ ...chartPresentation.response(chart), conversation: { topic: { report_kind: 'chart', chart_kind: 'people', province: stripped } }, meta: { fastPath: true, ollamaCalls: 0 } });
        }
        return res.json({ answer: `ไม่พบข้อมูลของจังหวัด${stripped} ในข้อมูลทดสอบ กรุณาระบุจังหวัดอื่น หรือพิมพ์คำสั่งใหม่`, grounded: false, dataSource: 'test', conversation: { topic: { pending: { type: 'chart_province', chart_kind: 'people' } } }, meta: { fastPath: true, ollamaCalls: 0 } });
      }
      const { pending: _drop, ...topicWithoutPending } = context.topic;
      req.body.context = { ...context, topic: Object.keys(topicWithoutPending).length ? topicWithoutPending : undefined };
    }
    if (detectVisitPlanIntent(message)) {
      return res.json({ answer: 'แผนการตรวจเยี่ยมใช้ข้อมูลทะเบียนและผลตรวจจริง กรุณาเลือกโหมดข้อมูลจริงและเข้าสู่ระบบด้วยบัญชีตำรวจ', grounded: false, dataSource: 'test', code: 'REAL_FEATURE_REQUIRED' });
    }
    // สรุป/ภาพรวมการตรวจเยี่ยมต้องใช้บันทึกการเยี่ยมจริง; a selected person's
    // plain visit-history question still goes through the ordinary test path.
    const visitStatsIntent = detectVisitStatsIntent(message);
    if (visitStatsIntent && (visitStatsIntent.strong || visitStatsIntent.station || !context.personId)) {
      return res.json({ answer: 'สรุปการตรวจเยี่ยมใช้บันทึกการเยี่ยมจากข้อมูลจริง กรุณาเลือกโหมดข้อมูลจริงและเข้าสู่ระบบด้วยบัญชีตำรวจ', grounded: false, dataSource: 'test', code: 'REAL_FEATURE_REQUIRED' });
    }

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
        model: result.model || activeOllamaModel(),
        routingMode: result.routingMode || OLLAMA_ROUTING_MODE,
        grounded: result.grounded,
        executionTier: result.executionTier || null,
        resolution: result.resolution || null,
        presentation: result.presentation || undefined,
        conversation: result.conversation || undefined,
        analysisMode: result.analysisMode || null,
        ollamaCalls: result.ollamaCalls != null ? result.ollamaCalls : null,
        timing: result.timing || undefined,
        meta: {
          responseTimeMs: Date.now() - startMs,
          routingMode: result.routingMode || OLLAMA_ROUTING_MODE,
          fastPath: !!result.fastPath,
          grounded: result.grounded,
          retryCount: result.retryCount || 0,
          executionTier: result.executionTier || null,
          resolution: result.resolution || null,
          analysisMode: result.analysisMode || null,
          ollamaCalls: result.ollamaCalls != null ? result.ollamaCalls : null,
          timing: result.timing || undefined,
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

module.exports = { createAIRoutes, checkOllamaAvailable, activeOllamaModel };
