const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');

const DEFAULT_TOP_K = 4;
const DEFAULT_CHUNK_SIZE = 1100;
const DEFAULT_CHUNK_OVERLAP = 180;

function walkMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkMarkdown(target);
    return entry.isFile() && entry.name.endsWith('.md') ? [target] : [];
  });
}

function chunkDocument(source, text, size = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP) {
  const sections = text.split(/(?=^#{1,3}\s)/m).filter((section) => section.trim());
  const chunks = [];
  for (const section of sections) {
    const title = section.match(/^#{1,3}\s+(.+)$/m)?.[1] ?? path.basename(source, '.md');
    for (let start = 0; start < section.length; start += size - overlap) {
      const content = section.slice(start, start + size).trim();
      if (content.length < 80) continue;
      chunks.push({
        id: crypto.createHash('sha256').update(`${source}:${start}:${content}`).digest('hex').slice(0, 16),
        source: path.basename(source), title, content,
      });
      if (start + size >= section.length) break;
    }
  }
  return chunks;
}

function lexicalScore(query, content) {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])];
  if (!words.length) return 0;
  const normalized = content.toLowerCase();
  return words.reduce((score, word) => score + (normalized.split(word).length - 1), 0) / words.length;
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return null;
  let dot = 0; let a2 = 0; let b2 = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; a2 += a[i] ** 2; b2 += b[i] ** 2; }
  return a2 && b2 ? dot / Math.sqrt(a2 * b2) : null;
}

function postJson(host, endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, host);
    const client = url.protocol === 'https:' ? require('https') : http;
    const payload = JSON.stringify(body);
    const request = client.request(url, {
      method: 'POST', timeout: 60_000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (response) => {
      const buffers = [];
      response.on('data', (chunk) => buffers.push(chunk));
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(buffers).toString('utf8'));
          if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(value.error || 'Embedding request failed'));
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => { request.destroy(); reject(new Error('Embedding request timed out')); });
    request.on('error', reject);
    request.write(payload); request.end();
  });
}

function createRag({ knowledgeDir, indexPath, ollamaHost, embedModel }) {
  let index = null;

  function load() {
    if (index) return index;
    if (fs.existsSync(indexPath)) {
      try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); return index; } catch (_) { /* rebuild lexical index */ }
    }
    const chunks = walkMarkdown(knowledgeDir).flatMap((file) => chunkDocument(file, fs.readFileSync(file, 'utf8')));
    index = { version: 1, embedding_model: null, chunks };
    return index;
  }

  async function embed(input) {
    const result = await postJson(ollamaHost, '/api/embed', { model: embedModel, input });
    return result.embeddings?.[0] ?? null;
  }

  async function rebuildEmbeddings() {
    const current = load();
    const chunks = [];
    for (const chunk of current.chunks) {
      const vector = await embed(`${chunk.title}\n${chunk.content}`);
      chunks.push({ ...chunk, vector });
    }
    index = { version: 1, embedding_model: embedModel, generated_at: new Date().toISOString(), chunks };
    fs.mkdirSync(path.dirname(indexPath), { recursive: true });
    fs.writeFileSync(indexPath, JSON.stringify(index));
    return index;
  }

  async function retrieve(query, topK = DEFAULT_TOP_K) {
    const current = load();
    let queryVector = null;
    if (current.embedding_model === embedModel && current.chunks.every((chunk) => Array.isArray(chunk.vector))) {
      try { queryVector = await embed(query); } catch (_) { /* lexical fallback keeps chat available */ }
    }
    return current.chunks
      .map((chunk) => ({ ...chunk, score: queryVector ? cosine(queryVector, chunk.vector) : lexicalScore(query, `${chunk.title}\n${chunk.content}`) }))
      .filter((chunk) => chunk.score !== null && chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ vector, ...chunk }) => chunk);
  }

  function status() {
    const current = load();
    return { chunk_count: current.chunks.length, embedding_model: current.embedding_model, index_path: indexPath };
  }

  return { rebuildEmbeddings, retrieve, status };
}

module.exports = { createRag, chunkDocument, lexicalScore };
