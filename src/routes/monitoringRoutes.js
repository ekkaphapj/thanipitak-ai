const express=require('express');
const {createMonitoringService}=require('../services/monitoringService');
function createMonitoringRoutes(db,authRequired,audit){
  const router=express.Router();const service=createMonitoringService(db);
  router.get('/',authRequired,(req,res)=>{
    try {
      const allowed=['person_type','level','page','person_id'];
      if(Object.keys(req.query).some(k=>!allowed.includes(k)))return res.status(400).json({error:'INVALID_FILTER'});
      const result=service.list(req.user,req.query);
      audit?.(req.user,'monitoring_access','/api/monitoring');
      return res.json(result);
    } catch(e){return res.status(400).json({error:e.message});}
  });
  return router;
}
module.exports={createMonitoringRoutes};
