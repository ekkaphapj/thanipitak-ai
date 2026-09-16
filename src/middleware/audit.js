const { createAuditor } = require('../repositories/auditRepo');

function attachAuditor(db) {
  return createAuditor(db);
}

module.exports = { attachAuditor };