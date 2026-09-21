const http = require('http');
const { AI_TOOLS } = require('./tools');
const { SYSTEM_PROMPT } = require('./systemPrompt');
const {detectMonitoringIntent,isSelectedMonitoringReasonFollowup,runMonitoring,renderMonitoring}=require('./monitoring');
const { parseSummaryIntent } = require('./../services/summaryService');
const { hasDBIntent } = require('./intentDetector');
const { detectFastPathIntent, runFastPath } = require('./fastPath');
const { detectOverview, TYPE_LABELS: OVERVIEW_TYPE_LABELS } = require('../services/overviewService');
const { sanitizeTopic, topicFromIntent } = require('./conversationTopic');
const { detectExportIntent, reportRequestFromExport } = require('./exportIntent');
const {
  detectPersonFactualIntent,
  validPersonId,
  runPersonFastPath,
} = require('./personFastPath');
const {
  detectPersonNameIntent,
  runPersonNameResolution,
} = require('./personNameResolver');
const {
  detectAnalysisIntent,
  runOneShotAnalysis,
} = require('./personAnalyzer');
const { runIntentRouter, INTENT_MODEL } = require('./intentRouter');
const rag = require('./rag');
const { detectDiscoveryIntent } = require('../services/discoveryService');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'scb10x/llama3.1-typhoon2-8b-instruct:latest';
const OLLAMA_ROUTING_MODE = process.env.OLLAMA_ROUTING_MODE || 'tools';
const OLLAMA_INTENT_MODEL = process.env.OLLAMA_INTENT_MODEL || INTENT_MODEL;
const MAX_TOOL_ITERATIONS = 5;
const REQUEST_TIMEOUT_MS = 120_000;

const DB_RETRY_INSTRUCTION =
  'คุณจำเป็นต้องเรียกใช้ tool ที่มีอยู่เพื่อตรวจสอบข้อมูลจริงจากระบบ Thanipithak ก่อนตอบ ห้ามตอบจากความจำ ห้ามตอบโดยไม่เรียก tool ก่อน เรียก tool ที่เหมาะสมเดี๋ยวนี้';

const SAFE_DB_FAILURE = 'ไม่สามารถตรวจสอบข้อมูลจากระบบได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง';

function postJson(urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, OLLAMA_HOST);
    const data = JSON.stringify(body);
    const proto = url.protocol === 'https:' ? require('https') : http;
    const req = proto.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Ollama HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error(`Ollama JSON parse error: ${e.message}`));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Ollama request timeout'));
    });
    req.on('error', (e) => reject(new Error(`Ollama connection error: ${e.message}`)));
    req.write(data);
    req.end();
  });
}

function isApprovedToolCall(toolCalls, toolRouter) {
  if (!toolCalls || toolCalls.length === 0) return false;
  for (const tc of toolCalls) {
    const name = tc.function && tc.function.name;
    if (name && toolRouter.ALLOWED_TOOLS.has(name)) return true;
  }
  return false;
}

async function chatWithTools(userMessage, toolRouter, currentUser, onToolCall, options = {}) {
  const requestFn = options.requestFn || postJson;
  const databaseIntent = hasDBIntent(userMessage);
  let retryCount = 0;

  async function runToolLoop(messages, toolsUsedSoFar) {
    let finalAnswer = '';
    let lastPeopleList = null;
    const localUsed = [...toolsUsedSoFar];

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await requestFn('/api/chat', {
        model: OLLAMA_MODEL,
        messages,
        tools: AI_TOOLS,
        stream: false,
        think: false,
        options: { temperature: 0, num_predict: 384 },
      });

      const msg = response.message;

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const assistantMessage = { role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls };
        messages.push(assistantMessage);

        for (const tc of msg.tool_calls) {
          const toolName = tc.function.name;
          let toolArgs = tc.function.arguments || {};
          if(toolName==='get_monitoring_persons' && selectedId!==null && /คนนี้|บุคคลนี้|รายนี้/.test(userMessage)) {
            // The backend owns the selected identity, even if the model omits it.
            toolArgs={...toolArgs,person_id:selectedId,level:'all'};
          }

          if (onToolCall) {
            onToolCall({ toolName, toolArgs, userId: currentUser.id, username: currentUser.username });
          }

          const result = await toolRouter.execute(toolName, toolArgs, currentUser);
          if(toolName==='get_monitoring_persons' && !result.error) {
            return {finalAnswer:renderMonitoring(result),toolsUsed:[...localUsed,toolName],presentation:{type:'monitoring_list',...result,filters:toolArgs||{}}};
          }
          if (toolName === 'search_persons' && Array.isArray(result?.persons)) {
            lastPeopleList = {
              type: 'person_list',
              total: result.total,
              returned: result.returned,
              page: result.page || 1,
              pageSize: result.pageSize || 20,
              filters: {
                person_type: toolArgs?.person_type || null,
                status: toolArgs?.status || null,
                province: toolArgs?.province || null,
                station: toolArgs?.station || null,
                district: toolArgs?.district || null,
                subdistrict: toolArgs?.subdistrict || null,
              },
              items: result.persons.map((p) => ({
                person_id: p.id,
                full_name: `${p.first_name} ${p.last_name || ''}`.trim(),
                person_type: p.person_type,
                status: p.status,
                district: p.district,
                subdistrict: p.subdistrict,
              })),
            };
          }
          if (toolName === 'get_person_detail' && result?.data?.id) {
            lastPeopleList = {
              type: 'person_list',
              total: 1,
              returned: 1,
              page: 1,
              pageSize: 1,
              filters: {},
              items: [{
                person_id: result.data.id,
                full_name: result.data.full_name || `${result.data.first_name} ${result.data.last_name || ''}`.trim(),
                person_type: result.data.person_type,
                status: result.data.status,
                district: result.data.district,
                subdistrict: result.data.subdistrict,
              }],
            };
          }

          if (toolRouter.ALLOWED_TOOLS.has(toolName) && result && !result.error) {
            localUsed.push(toolName);
          }

          // Do not let a model relabel station-scoped totals as global totals.
          if (msg.tool_calls.length === 1 && toolName === 'get_statistics' &&
              /ทุกสถานี|ทั้งระบบ/.test(userMessage) && /จำนวน|กี่คน/.test(userMessage) &&
              Number.isFinite(result?.data?.total)) {
            return { finalAnswer: `ในพื้นที่ที่ท่านมีสิทธิ์เข้าถึงมีบุคคลทั้งหมด ${result.data.total} คน`, toolsUsed: localUsed, presentation: lastPeopleList };
          }

          messages.push({
            role: 'tool',
            content: JSON.stringify(result),
          });
        }
      } else {
        finalAnswer = msg.content || '';
        break;
      }
    }

    return { finalAnswer, toolsUsed: localUsed, presentation: lastPeopleList || undefined };
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + '\nตอบเฉพาะที่ถามอย่างกระชับ ผล tool เป็นข้อมูลเฉพาะพื้นที่ที่ผู้ใช้มีสิทธิ์ ห้ามเรียกว่าเป็นข้อมูลทุกสถานีหรือทั้งระบบ ไม่เพิ่มตารางหรือสถิติอื่นที่ไม่ได้ถาม' },
    { role: 'user', content: userMessage },
  ];
  const selectedId = validPersonId(options.context?.personId);
  if (selectedId !== null) {
    const selected = await toolRouter.getPersonSummary(currentUser, selectedId);
    if (!selected.ok) return { answer: 'ไม่พบข้อมูลบุคคลนี้ในพื้นที่ที่รับผิดชอบ', toolsUsed: [], grounded: false, databaseIntent: true, retryCount: 0 };
    // An authorized identifier only: facts must still come from scoped tools.
    messages.splice(1, 0, { role: 'system', content: `บุคคลที่ผู้ใช้เลือกและระบบตรวจสิทธิ์แล้วมี person_id=${selectedId} หากคำถามกล่าวถึงคนนี้ให้ใช้รหัสนี้เรียก tool ห้ามเปลี่ยนสิทธิ์หรือเดารหัสอื่น` });
  }
  const toolsUsed = [];

  const firstResult = await runToolLoop(messages, toolsUsed);
  toolsUsed.length = 0;
  firstResult.toolsUsed.forEach((n) => toolsUsed.push(n));

  if (databaseIntent && toolsUsed.length === 0 && firstResult.finalAnswer) {
    retryCount = 1;
    messages.push({ role: 'user', content: DB_RETRY_INSTRUCTION });

    const retryResult = await runToolLoop(messages, toolsUsed);
    toolsUsed.length = 0;
    retryResult.toolsUsed.forEach((n) => toolsUsed.push(n));

    if (toolsUsed.length > 0 && retryResult.finalAnswer) {
      return {
        answer: retryResult.finalAnswer,
        toolsUsed,
        grounded: true,
        databaseIntent,
        retryCount,
        presentation: retryResult.presentation,
      };
    }

    return {
      answer: SAFE_DB_FAILURE,
      toolsUsed,
      grounded: false,
      databaseIntent,
      retryCount,
    };
  }

  return {
    answer: firstResult.finalAnswer,
    toolsUsed,
    grounded: databaseIntent ? toolsUsed.length > 0 : null,
    databaseIntent,
    retryCount: 0,
    presentation: firstResult.presentation,
  };
}

function createAIGateway(toolRouter) {
  return {
    chatWithTools: (userMessage, currentUser, onToolCall, options) =>
      chatWithToolsWithFastPath(userMessage, toolRouter, currentUser, onToolCall, options),
  };
}

// UI-only preflight.  It deliberately does not read registry data, execute a
// tool, or call Ollama.  A false result is reserved for deterministic paths
// that are known to bypass Local AI; all uncertain routes return true so the
// processing cue is never delayed until after inference has started.
function willUseLocalAi(userMessage, context = {}) {
  const selectedPersonId = validPersonId(context.personId);
  if (detectDiscoveryIntent(userMessage)) return false;
  if (parseSummaryIntent(userMessage) && selectedPersonId === null) return false;
  if (detectExportIntent(userMessage)) return false;
  if (detectMonitoringIntent(userMessage)) return false;
  const fastIntent = detectFastPathIntent(userMessage, sanitizeTopic(context.topic));
  if (fastIntent) return false;
  if (process.env.RAG_ENABLED === 'true' && !hasDBIntent(userMessage) && rag.directAnswer(userMessage)) return false;
  return true;
}

// Phase 3.2: conservative deterministic fast path for high-confidence intents.
// This is a performance shortcut (routing), NOT an authorization layer.
// Scope always comes from the authenticated backend user; user-supplied
// station/role/user_id are never accepted here. When confidence is not high,
// it falls through to the untouched Phase 3.1 gateway (chatWithTools).
async function chatWithToolsWithFastPath(userMessage, toolRouter, currentUser, onToolCall, options = {}) {
  const discoveryIntent = detectDiscoveryIntent(userMessage);
  if (discoveryIntent && !options.forceQwen) {
    const out = toolRouter.discover(currentUser, discoveryIntent);
    if (onToolCall) onToolCall({ toolName: 'discover_aggregate_patterns', toolArgs: discoveryIntent, userId: currentUser.id, username: currentUser.username });
    return {
      answer: out.answer, toolsUsed: ['discover_aggregate_patterns'], grounded: true,
      databaseIntent: true, retryCount: 0, fastPath: true, intent: 'aggregate_discovery',
      executionTier: 1, ollamaCalls: 0, presentation: out.presentation,
    };
  }
  const selectedPersonId = validPersonId((options.context || {}).personId);
  const requestedOverview = detectOverview(userMessage);
  // Category overview and an explicitly selected person are different scopes.
  // Fetch the selected person through the authorized tool before comparing
  // types; a frontend-provided type must never influence this decision.
  if (requestedOverview?.filters?.person_type && selectedPersonId !== null && !options.forceQwen) {
    const selected = await toolRouter.getPersonSummary(currentUser, selectedPersonId);
    if (!selected.ok) {
      return { answer: 'ไม่พบข้อมูลบุคคลที่เลือกในพื้นที่ที่รับผิดชอบ', toolsUsed: ['get_person_summary'], grounded: true, databaseIntent: true, retryCount: 0, fastPath: true, intent: 'selected_person_unavailable', executionTier: 2, ollamaCalls: 0 };
    }
    if (onToolCall) onToolCall({ toolName: 'get_person_summary', toolArgs: { person_id: selectedPersonId }, userId: currentUser.id, username: currentUser.username });
    const selectedType = selected.data.person && selected.data.person.person_type;
    const requestedType = requestedOverview.filters.person_type;
    if (selectedType !== requestedType) {
      const selectedLabel = OVERVIEW_TYPE_LABELS[selectedType] || 'บุคคลที่เลือก';
      const requestedLabel = OVERVIEW_TYPE_LABELS[requestedType] || 'ประเภทที่สั่ง';
      const selectedName = [selected.data.person.first_name, selected.data.person.last_name].filter(Boolean).join(' ') || 'บุคคลที่เลือก';
      return {
        answer: `ขณะนี้เลือก${selectedName} ซึ่งเป็น${selectedLabel} แต่คำสั่งขอข้อมูล${requestedLabel} ต้องการข้อมูลบุคคลที่เลือก หรือภาพรวม${requestedLabel}ตามที่สั่ง`,
        toolsUsed: ['get_person_summary'], grounded: true, databaseIntent: true, retryCount: 0, fastPath: true, intent: 'selected_type_conflict', executionTier: 2, ollamaCalls: 0,
        presentation: { type: 'summary_choices', selectionConflict: true, choices: [
          { label: `1. ข้อมูลบุคคลที่เลือก (${selectedLabel})`, message: 'สรุปประวัติคนนี้' },
          { label: `2. ภาพรวม${requestedLabel}ตามที่สั่ง`, message: userMessage, clearSelection: true },
        ] },
      };
    }
  }
  const summaryIntent = parseSummaryIntent(userMessage);
  if (summaryIntent && selectedPersonId === null && !options.forceQwen) {
    const out = summaryIntent.intent === 'summary_choices'
      ? toolRouter.summaryChoices(currentUser, 'เงื่อนไขสรุปยังไม่ครบ เลือกรูปแบบหรือพื้นที่ที่ต้องการได้')
      : toolRouter.summarizePersons(currentUser, summaryIntent);
    if (out.toolsUsed.length && onToolCall) {
      onToolCall({ toolName: out.toolsUsed[0], toolArgs: summaryIntent, userId: currentUser.id, username: currentUser.username });
    }
    return { ...out, databaseIntent: true, retryCount: 0, fastPath: true, intent: summaryIntent.intent, executionTier: 1, ollamaCalls: 0 };
  }
  const exportIntent = detectExportIntent(userMessage);
  if (exportIntent && !options.forceQwen) {
    const topic = sanitizeTopic((options.context || {}).topic);
    const reportRequest = reportRequestFromExport(exportIntent, topic);
    const bits = [];
    if (reportRequest.filters.person_type) bits.push({ psychiatric: 'ผู้ป่วยจิตเวช', drug_user: 'ผู้เสพ', dealer: 'ผู้ค้า', released: 'ผู้พ้นโทษ' }[reportRequest.filters.person_type]);
    if (reportRequest.filters.level === 'high') bits.push('เสี่ยงสูง');
    if (reportRequest.filters.level === 'watch') bits.push('เฝ้าระวัง');
    const scope = bits.length ? bits.join(' • ') : 'บุคคลในพื้นที่ที่ท่านมีสิทธิ์เข้าถึง';
    const files = exportIntent.formats.map((item) => item === 'xlsx' ? 'Excel' : 'PDF').join(' และ ');
    const needsConfirm = exportIntent.confirm || Boolean(topic);
    const answer = needsConfirm
      ? `ต้องการสร้างรายงานของรายการหรือภาพรวมล่าสุดใช่หรือไม่? เลือก 1. ใช่ หรือ 2. ไม่ (จะสร้างของ${scope} ตามสิทธิ์บัญชีนี้)`
      : `พร้อมสร้างรายงาน${files} ของ${scope} ตามสิทธิ์บัญชีนี้ กดดาวน์โหลดด้านล่าง (ตรวจรายชื่อก่อนนำไปใช้)`;
    return {
      answer,
      toolsUsed: [],
      grounded: true,
      databaseIntent: true,
      retryCount: 0,
      fastPath: true,
      intent: 'export_report',
      executionTier: 1,
      ollamaCalls: 0,
      presentation: {
        type: 'report_offer',
        formats: exportIntent.formats,
        auto: needsConfirm ? null : exportIntent.auto,
        confirm: needsConfirm,
        reportRequest,
      },
      conversation: { topic: topic || (reportRequest.filters.person_type ? { person_type: reportRequest.filters.person_type } : null) },
    };
  }
  let monitoringIntent=detectMonitoringIntent(userMessage);
  // A short follow-up such as “เพราะอะไร” has no risk keyword on its own.
  // When the UI has an authorized selected person, it means the reason for
  // that person's monitoring status and remains deterministic.
  if (!monitoringIntent && selectedPersonId !== null && isSelectedMonitoringReasonFollowup(userMessage)) {
    monitoringIntent = {
      level: 'all',
      person_types: [],
      selected: true,
      count: false,
      page: 1,
      name: null,
    };
  }
  // A selected person is an explicit UI choice. For monitoring questions it
  // takes precedence over list/type wording, so the answer never expands to
  // every matching person in the user's station.
  if (monitoringIntent && selectedPersonId !== null) {
    monitoringIntent = {
      ...monitoringIntent,
      selected: true,
      name: null,
      person_types: [],
      psychiatric_subtype: undefined,
      most_wanted: undefined,
      count: false,
      page: 1,
    };
  }
  if(monitoringIntent && !options.forceQwen) {
    const out=await runMonitoring(monitoringIntent,options.context,toolRouter,currentUser,onToolCall);
    return {...out,databaseIntent:true,retryCount:0,fastPath:true,intent:'monitoring',executionTier:1,ollamaCalls:0};
  }
  // ── Tier 2: selected-person factual fast path (deterministic, zero Ollama) ──
  const personId = selectedPersonId;
  const personIntent = personId !== null ? detectPersonFactualIntent(userMessage) : null;

  if (personIntent && !options.forceQwen) {
    const tier2 = await runPersonFastPath(personIntent, personId, toolRouter, currentUser);
    if (tier2.ok) {
      if (onToolCall) {
        onToolCall({
          toolName: tier2.toolsUsed[0],
          toolArgs: tier2.toolArgs,
          userId: currentUser.id,
          username: currentUser.username,
        });
      }
      return {
        answer: tier2.answer,
        toolsUsed: tier2.toolsUsed,
        grounded: tier2.grounded,
        databaseIntent: true,
        retryCount: 0,
        fastPath: true,
        intent: tier2.intent,
        executionTier: 2,
        presentation: tier2.presentation || undefined,
      };
    }
  }

  // ── Tier 2: explicit-name factual fast path (deterministic, zero Ollama) ──
  const nameQuery = detectPersonNameIntent(userMessage);
  if (nameQuery && !options.forceQwen) {
    const named = await runPersonNameResolution(nameQuery, toolRouter, currentUser);
    if (named.ok) {
      for (const c of named.toolCalls || []) {
        if (onToolCall) {
          onToolCall({
            toolName: c.toolName,
            toolArgs: c.toolArgs,
            userId: currentUser.id,
            username: currentUser.username,
          });
        }
      }
      return {
        answer: named.answer,
        toolsUsed: named.toolsUsed,
        grounded: named.grounded,
        databaseIntent: true,
        retryCount: 0,
        fastPath: true,
        intent: named.intent,
        executionTier: 2,
        presentation: named.presentation || undefined,
        resolution: named.resolution,
      };
    }
  }

  // ── Tier 3: one-shot local AI analysis (deterministic person first) ──
  // True analytical questions about ONE known person run exactly ONE Local AI
  // inference over an authorized compact fact packet. There is NO tool loop.
  const analysis = detectAnalysisIntent(userMessage);
  if (analysis && !options.forceQwen) {
    const out = await runOneShotAnalysis({
      analysis,
      personId,
      userMessage,
      toolRouter,
      currentUser,
      requestFn: options.requestFn || postJson,
      model: OLLAMA_MODEL,
    });
    if (out.ok) {
      for (const c of out.toolCalls || []) {
        if (onToolCall) {
          onToolCall({
            toolName: c.toolName,
            toolArgs: c.toolArgs,
            userId: currentUser.id,
            username: currentUser.username,
          });
        }
      }
      return out.response;
    }
  }

  // ── Tier 1: conservative count/list fast path ──
  const incomingTopic = sanitizeTopic((options.context || {}).topic);
  const fastIntent = detectFastPathIntent(userMessage, incomingTopic);
  if (fastIntent && !options.forceQwen) {
    const fastResult = await runFastPath(fastIntent.intent, currentUser, toolRouter, {
      page: fastIntent.page,
      filters: fastIntent.filters,
      groupBy: fastIntent.groupBy,
      direction: fastIntent.direction,
      showAll: fastIntent.showAll,
      barePsychiatric: fastIntent.barePsychiatric,
      mentionedTypes: fastIntent.mentionedTypes,
      answer: fastIntent.answer,
      presentation: fastIntent.presentation,
      requestedScope: fastIntent.requestedScope,
    });
    if (fastResult.ok) {
      if (onToolCall && fastResult.toolsUsed.length > 0) {
        onToolCall({
          toolName: fastResult.toolsUsed[0],
          toolArgs: fastResult.toolArgs,
          userId: currentUser.id,
          username: currentUser.username,
        });
      }
      return {
        answer: fastResult.answer,
        toolsUsed: fastResult.toolsUsed,
        grounded: true,
        databaseIntent: true,
        retryCount: 0,
        fastPath: true,
        intent: fastIntent.intent,
        executionTier: 1,
        presentation: fastResult.presentation,
        conversation: { topic: topicFromIntent(fastIntent) || incomingTopic },
      };
    }
  }

  if (process.env.RAG_ENABLED === 'true' && !hasDBIntent(userMessage) && !options.forceQwen) {
    const found = await rag.answer(userMessage, options.requestFn || postJson, OLLAMA_MODEL);
    if (found) return { answer: found.answer, toolsUsed: [], grounded: true, databaseIntent: false, retryCount: 0, fastPath: false, executionTier: 3, rag: { sources: found.sources } };
  }

  // Experimental no-tool routing mode. The small model emits only a validated
  // intent plan; all database reads still go through the allowlisted tool
  // router and authenticated user scope. Native tool calling remains the
  // default and can be forced for a single request with forceQwen.
  const routingMode = options.routingMode || OLLAMA_ROUTING_MODE;
  if (routingMode === 'intent' && !options.forceQwen) {
    try {
      const intentResult = await runIntentRouter(userMessage, {
        requestFn: options.requestFn || postJson,
        model: options.intentModel || OLLAMA_INTENT_MODEL,
        toolRouter,
        currentUser,
        selectedPersonId,
        onToolCall,
      });
      return {
        ...intentResult,
        databaseIntent: true,
        retryCount: 0,
        routingMode: 'intent',
        fastPath: false,
        executionTier: 3,
      };
    } catch (err) {
      // A malformed or unavailable local model must fail closed. Do not fall
      // through to the native tool path because that would silently change
      // the selected experimental backend.
      return {
        answer: 'โหมดทดลอง Intent JSON ยังไม่สามารถแปลคำถามนี้ได้ กรุณาลองใหม่หรือเปลี่ยนกลับเป็นโหมด tools',
        toolsUsed: [],
        grounded: false,
        databaseIntent: true,
        retryCount: 0,
        routingMode: 'intent',
        executionTier: 3,
        fastPath: false,
        ollamaCalls: 1,
        intentRouterError: err.message,
      };
    }
  }

  const result = await chatWithTools(userMessage, toolRouter, currentUser, onToolCall, options);
  result.fastPath = false;
  result.executionTier = 3;
  result.presentation = result.presentation || undefined;
  return result;
}

module.exports = {
  createAIGateway,
  chatWithTools,
  chatWithToolsWithFastPath,
  willUseLocalAi,
  OLLAMA_MODEL,
  MAX_TOOL_ITERATIONS,
  DB_RETRY_INSTRUCTION,
  SAFE_DB_FAILURE,
  OLLAMA_ROUTING_MODE,
  OLLAMA_INTENT_MODEL,
};
