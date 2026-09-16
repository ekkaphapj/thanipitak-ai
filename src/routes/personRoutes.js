const express = require('express');
const { createPersonService } = require('../services/personService');

function createPersonRoutes(db, audit, authRequired) {
  const router = express.Router();
  const persons = createPersonService(db);

  router.get('/', authRequired, (req, res) => {
    const result = persons.listPersons(req.user, req.query);
    audit(req.user, 'person_list_access', '/api/persons');
    return res.json({ data: result.rows, meta: { total: result.total, limit: req.query.limit, offset: req.query.offset } });
  });

  router.get('/:id', authRequired, (req, res) => {
    const check = persons.getPerson(req.user, req.params.id);
    if (!check.ok) {
      audit(req.user, 'forbidden_access_attempt', '/api/persons/' + req.params.id, req.params.id);
      return res.status(404).json({ error: 'ไม่พบบุคคลนี้', code: 'NOT_FOUND' });
    }
    audit(req.user, 'person_detail_access', '/api/persons/' + req.params.id, check.person.id);
    return res.json({ data: check.person });
  });

  router.get('/:id/visits', authRequired, (req, res) => {
    const check = persons.getVisits(req.user, req.params.id);
    if (!check.ok) {
      audit(req.user, 'forbidden_access_attempt', '/api/persons/' + req.params.id + '/visits', req.params.id);
      return res.status(404).json({ error: 'ไม่พบบุคคลนี้', code: 'NOT_FOUND' });
    }
    audit(req.user, 'visits_access', '/api/persons/' + req.params.id + '/visits', req.params.id);
    return res.json({ data: check.visits });
  });

  router.get('/:id/urine-tests', authRequired, (req, res) => {
    const check = persons.getUrineTests(req.user, req.params.id);
    if (!check.ok) {
      audit(req.user, 'forbidden_access_attempt', '/api/persons/' + req.params.id + '/urine-tests', req.params.id);
      return res.status(404).json({ error: 'ไม่พบบุคคลนี้', code: 'NOT_FOUND' });
    }
    audit(req.user, 'urine_tests_access', '/api/persons/' + req.params.id + '/urine-tests', req.params.id);
    return res.json({ data: check.tests });
  });

  return router;
}

module.exports = { createPersonRoutes };