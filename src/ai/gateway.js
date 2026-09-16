const http = require('http');
const { AI_TOOLS } = require('./tools');
const { SYSTEM_PROMPT } = require('./systemPrompt');
const { hasDBIntent } = require('./intentDetector');
const { detectFastPathIntent, runFastPath } = require('./fastPath');

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:9b';
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
    const localUsed = [...toolsUsedSoFar];

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await requestFn('/api/chat', {
        model: OLLAMA_MODEL,
        messages,
        tools: AI_TOOLS,
        stream: false,
        temperature: 0,
      });

      const msg = response.message;

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const assistantMessage = { role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls };
        messages.push(assistantMessage);

        for (const tc of msg.tool_calls) {
          const toolName = tc.function.name;
          const toolArgs = tc.function.arguments || {};

          if (onToolCall) {
            onToolCall({ toolName, toolArgs, userId: currentUser.id, username: currentUser.username });
          }

          const result = await toolRouter.execute(toolName, toolArgs, currentUser);

          if (toolRouter.ALLOWED_TOOLS.has(toolName)) {
            localUsed.push(toolName);
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

    return { finalAnswer, toolsUsed: localUsed };
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];
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
  };
}

function createAIGateway(toolRouter) {
  return {
    chatWithTools: (userMessage, currentUser, onToolCall, options) =>
      chatWithToolsWithFastPath(userMessage, toolRouter, currentUser, onToolCall, options),
  };
}

// Phase 3.2: conservative deterministic fast path for high-confidence intents.
// This is a performance shortcut (routing), NOT an authorization layer.
// Scope always comes from the authenticated backend user; user-supplied
// station/role/user_id are never accepted here. When confidence is not high,
// it falls through to the untouched Phase 3.1 gateway (chatWithTools).
async function chatWithToolsWithFastPath(userMessage, toolRouter, currentUser, onToolCall, options = {}) {
  const fastIntent = detectFastPathIntent(userMessage);
  if (fastIntent && !options.forceQwen) {
    const fastResult = await runFastPath(fastIntent.intent, currentUser, toolRouter, { page: fastIntent.page });
    if (fastResult.ok) {
      if (onToolCall) {
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
        presentation: fastResult.presentation,
      };
    }
  }

  const result = await chatWithTools(userMessage, toolRouter, currentUser, onToolCall, options);
  result.fastPath = false;
  result.presentation = result.presentation || undefined;
  return result;
}

module.exports = {
  createAIGateway,
  chatWithTools,
  chatWithToolsWithFastPath,
  OLLAMA_MODEL,
  MAX_TOOL_ITERATIONS,
  DB_RETRY_INSTRUCTION,
  SAFE_DB_FAILURE,
};
