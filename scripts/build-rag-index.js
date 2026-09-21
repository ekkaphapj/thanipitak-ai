const path = require('path');
const { createRag } = require('../src/ai/rag');

const rag = createRag({
  knowledgeDir: process.env.RAG_KNOWLEDGE_DIR || path.join(__dirname, '..', 'knowledge'),
  indexPath: process.env.RAG_INDEX_PATH || path.join(__dirname, '..', 'data', 'rag-index.json'),
  ollamaHost: process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  embedModel: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',
});

rag.rebuildEmbeddings()
  .then((index) => console.log(`Built RAG index: ${index.chunks.length} chunks using ${index.embedding_model}`))
  .catch((error) => { console.error(`RAG index failed: ${error.message}`); process.exitCode = 1; });
