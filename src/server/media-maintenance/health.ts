import 'server-only';
import { maintenancePool } from './store';

export async function mediaMaintenanceHealth() {
  try {
    const pool=maintenancePool();
    const [last,active,variants]=await Promise.all([
      pool.query(`SELECT completed_at,restore_receipt,manifest_receipt FROM media_maintenance_run WHERE status='complete' AND retired_at IS NULL ORDER BY day DESC LIMIT 1`),
      pool.query(`SELECT phase,status,heartbeat_at FROM media_maintenance_run WHERE status<>'complete' ORDER BY day DESC LIMIT 1`),
      pool.query(`SELECT count(*) FILTER(WHERE status='ready')::int AS ready,count(*) FILTER(WHERE status<>'ready')::int AS pending FROM media_delivery_variant`),
    ]);
    return {available:true as const,enabled:process.env.MEDIA_BACKUP_ENABLED==='1',
      lastBackupAt:last.rows[0]?.completed_at?.toISOString()??null,stale:Boolean(last.rows[0]?.completed_at&&Date.now()-last.rows[0].completed_at.getTime()>36*60*60*1000),restoreVerified:last.rows[0]?.restore_receipt?.verified===true,
      active:active.rows[0]?{phase:String(active.rows[0].phase),retry:active.rows[0].status==='retry'||Date.now()-active.rows[0].heartbeat_at.getTime()>20*60*1000}:null,
      variants:Number(variants.rows[0]?.ready??0),pendingVariants:Number(variants.rows[0]?.pending??0),objects:Number(last.rows[0]?.manifest_receipt?.objects??0)};
  }catch{return {available:false as const};}
}
