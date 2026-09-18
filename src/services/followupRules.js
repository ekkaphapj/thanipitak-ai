'use strict';

const FOLLOWUP_INTERVAL_DAYS = Object.freeze({
  psychiatric: 30,
  drug_user: 60,
  dealer: 15,
});

const DEFAULT_FOLLOWUP_INTERVAL_DAYS = 30;

function followupIntervalDays(personType) {
  return FOLLOWUP_INTERVAL_DAYS[personType] || DEFAULT_FOLLOWUP_INTERVAL_DAYS;
}

function sqlDaysAgo(days) {
  return `date('now', '-${Number(days)} days')`;
}

function overduePredicateSql(alias = 'p') {
  const col = alias ? `${alias}.` : '';
  const cases = Object.entries(FOLLOWUP_INTERVAL_DAYS)
    .map(([type, days]) => `WHEN '${type}' THEN ${sqlDaysAgo(days)}`)
    .join(' ');
  return `${col}status != 'completed' AND (
      ${col}last_visit_date IS NULL OR (
        CASE ${col}person_type
          ${cases}
          ELSE ${sqlDaysAgo(DEFAULT_FOLLOWUP_INTERVAL_DAYS)}
        END > ${col}last_visit_date
      )
    )`;
}

function intervalDaysSelectSql(alias = 'p') {
  const col = alias ? `${alias}.` : '';
  const cases = Object.entries(FOLLOWUP_INTERVAL_DAYS)
    .map(([type, days]) => `WHEN '${type}' THEN ${Number(days)}`)
    .join(' ');
  return `CASE ${col}person_type ${cases} ELSE ${DEFAULT_FOLLOWUP_INTERVAL_DAYS} END`;
}

module.exports = {
  FOLLOWUP_INTERVAL_DAYS,
  DEFAULT_FOLLOWUP_INTERVAL_DAYS,
  followupIntervalDays,
  overduePredicateSql,
  intervalDaysSelectSql,
};
