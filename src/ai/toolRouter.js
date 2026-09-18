const { createPersonService } = require('../services/personService');
const { createStatisticsService } = require('../services/statisticService');
const { createFollowupService } = require('../services/followupService');
const personRepo = require('../repositories/personRepo');
const {createMonitoringService}=require('../services/monitoringService');
const {createSummaryService}=require('../services/summaryService');
const {createOverviewService}=require('../services/overviewService');

const ALLOWED_TOOLS = new Set([
  'get_statistics',
  'search_persons',
  'get_person_summary',
  'get_person_detail',
  'get_visit_history',
  'get_urine_history',
  'get_overdue_followups',
  'get_monitoring_persons',
  'summarize_persons',
  'get_overview',
]);

const SEARCH_PAGE_DEFAULT = 20;
const SEARCH_PAGE_MAX = 50;

function createToolRouter(db) {
  const persons = createPersonService(db);
  const statistics = createStatisticsService(db);
  const followups = createFollowupService(db);
  const summaries = createSummaryService(db);
  const overview = createOverviewService(db);

  async function execute(toolName, args, currentUser) {
    if (!ALLOWED_TOOLS.has(toolName)) {
      return { error: `Tool "${toolName}" ไม่ได้รับอนุญาตให้ใช้งาน` };
    }

    try {
      switch (toolName) {
        case 'summarize_persons': return summaries.summarize(currentUser, args);
        case 'get_overview': return overview.summarize(currentUser, args || {});
        case 'get_monitoring_persons': return createMonitoringService(db).list(currentUser,args);
        case 'get_statistics': {
          const result = statistics.getStatistics(currentUser);
          return { data: result };
        }

        case 'search_persons': {
          const query = {};
          if (args.query) query.search = args.query;
          if (args.person_type) query.person_type = args.person_type;
          if (args.status) query.status = args.status;
          if (args.province) query.province = args.province;
          if (args.station) query.station = args.station;
          if (args.district) query.district = args.district;
          if (args.subdistrict) query.subdistrict = args.subdistrict;
          const rawLimit = Number.parseInt(args.limit, 10);
          const rawOffset = Number.parseInt(args.offset, 10);
          const limit =
            Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, SEARCH_PAGE_MAX) : SEARCH_PAGE_DEFAULT;
          const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
          const result = persons.listPersonsWithSummary(currentUser, { ...query, limit, offset });
          return {
            total: result.total,
            returned: result.rows.length,
            page: Math.floor(offset / limit) + 1,
            pageSize: limit,
            summary: result.summary,
            persons: result.rows.map((p) => ({
              id: p.id,
              first_name: p.first_name,
              last_name: p.last_name,
              person_type: p.person_type,
              status: p.status,
              district: p.district,
              subdistrict: p.subdistrict,
            })),
          };
        }

        case 'get_person_detail': {
          const pid = Number(args.person_id);
          if (!Number.isFinite(pid) || pid <= 0) {
            return { error: 'person_id ไม่ถูกต้อง' };
          }
          const check = persons.getPersonWithVisitStats(currentUser, pid);
          if (!check.ok) {
            return { error: 'ไม่พบบุคคลนี้ในพื้นที่ที่รับผิดชอบ' };
          }
          const p = check.person;
          const vs = check.visitStats;
          return {
            data: {
              id: p.id,
              synthetic_code: p.synthetic_code,
              first_name: p.first_name,
              last_name: p.last_name,
              full_name: p.first_name + ' ' + p.last_name,
              person_type: p.person_type,
              district: p.district,
              subdistrict: p.subdistrict,
              station_id: p.station_id,
              status: p.status,
              last_visit_date: p.last_visit_date,
              created_at: p.created_at,
              visit_count: vs.visit_count,
              latest_visit: vs.latest_visit,
            },
          };
        }

        case 'get_visit_history': {
          const pid = Number(args.person_id);
          if (!Number.isFinite(pid) || pid <= 0) {
            return { error: 'person_id ไม่ถูกต้อง' };
          }
          const visitCheck = persons.getVisits(currentUser, pid);
          if (!visitCheck.ok) {
            return { error: 'ไม่พบบุคคลนี้ในพื้นที่ที่รับผิดชอบ' };
          }
          const visitStats = personRepo.getVisitStatsForPerson(db, pid);
          return {
            visit_count: visitStats.visit_count,
            latest_visit: visitStats.latest_visit,
            data: visitCheck.visits.map((v) => ({
              id: v.id,
              visit_date: v.visit_date,
              result: v.result,
              note: v.note,
              officer_name: v.officer_name,
            })),
          };
        }

        case 'get_urine_history': {
          const pid = Number(args.person_id);
          if (!Number.isFinite(pid) || pid <= 0) {
            return { error: 'person_id ไม่ถูกต้อง' };
          }
          const urineCheck = persons.getUrineTests(currentUser, pid);
          if (!urineCheck.ok) {
            return { error: 'ไม่พบบุคคลนี้ในพื้นที่ที่รับผิดชอบ' };
          }
          return {
            data: urineCheck.tests.map((t) => ({
              id: t.id,
              test_date: t.test_date,
              result: t.result,
              officer_name: t.officer_name,
            })),
          };
        }

        case 'get_person_summary': {
          const pid = Number(args.person_id);
          if (!Number.isFinite(pid) || pid <= 0) {
            return { error: 'person_id ไม่ถูกต้อง' };
          }
          const result = persons.getPersonSummary(currentUser, pid);
          if (!result.ok) {
            return { error: 'ไม่พบข้อมูลบุคคลนี้ในพื้นที่ที่รับผิดชอบ' };
          }
          return { data: result.data };
        }

        case 'get_overdue_followups': {
          const result = followups.listOverdue(currentUser, { limit: 20, offset: 0 });
          return {
            data: result.rows.map((p) => ({
              id: p.id,
              first_name: p.first_name,
              last_name: p.last_name,
              person_type: p.person_type,
              status: p.status,
              last_visit_date: p.last_visit_date,
            })),
            total: result.total,
          };
        }

        default:
          return { error: `Tool "${toolName}" ไม่ได้รับอนุญาตให้ใช้งาน` };
      }
    } catch (err) {
      return { error: `เกิดข้อผิดพลาดขณะเรียกใช้ tool: ${err.message}` };
    }
  }

  return {
    execute,
    ALLOWED_TOOLS,
    getPersonSummary: (user, personId) => persons.getPersonSummary(user, personId),
    // Authorized search used by the deterministic name resolver (STEP 3).
    // Scope always comes from the backend user, never from the frontend/prompt.
    searchPersons: (user, search, limit, filters = {}) =>
      persons.listPersons(user, {
        search: String(search == null ? '' : search).slice(0, 100),
        person_type: filters.person_type,
        status: filters.status,
        province: filters.province,
        station: filters.station,
        district: filters.district,
        subdistrict: filters.subdistrict,
        limit: Number.isInteger(limit) && limit > 0 ? limit : 100,
        offset: 0,
      }),
    summarizePersons: (user, request) => summaries.summarize(user, request),
    summaryChoices: (user, prompt) => summaries.choices(user, prompt),
    groupPersons: (user, opts) => persons.groupByLocation(user, opts),
  };
}

module.exports = { createToolRouter, ALLOWED_TOOLS };
