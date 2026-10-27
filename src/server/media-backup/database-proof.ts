import { createHash } from 'node:crypto';

export type QueryClient = { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> };
export type TableProof = { schema: string; name: string; rows: number; sha256: string };
export type DatabaseProof = {
  format: 1; hashMethod: string; tables: TableProof[]; sequences: Record<string, unknown>[];
  structuralCatalog: Record<string, unknown>[]; securityCatalog: Record<string, unknown>[];
};
const quoteIdentifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

// Keep the established offline backup proof contract. This server module has
// no CLI, filesystem, child-process, Keychain or inherited credential access.
/** Use inside the owner's exported READ ONLY snapshot, or the isolated restore transaction. No row contents are retained. */
export async function collectDatabaseProof(client: QueryClient): Promise<DatabaseProof> {
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  await client.query('SET LOCAL row_security = off');
  // pg_dump changes the restore session's search_path. Normalize both sides so
  // deparsed types, defaults, FK and trigger definitions compare identically.
  await client.query('SET LOCAL search_path = pg_catalog, public');
  const relationRows = (await client.query(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p') ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`)).rows;
  const tables: TableProof[] = [];
  for (let index = 0; index < relationRows.length; index++) {
    const relation = relationRows[index];
    const schema = String(relation.schema), name = String(relation.name);
    const cursor = quoteIdentifier(`jesie_backup_rows_${index}`);
    const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
    await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT to_jsonb(t)::text AS line FROM ${qualified} t ORDER BY to_jsonb(t)::text COLLATE "C"`);
    const hash = createHash('sha256'); let rows = 0;
    try {
      while (true) {
        const chunk = (await client.query(`FETCH 250 FROM ${cursor}`)).rows;
        for (const row of chunk) { if (typeof row.line !== 'string') throw new Error('BACKUP_DB_INVALID_PROOF_ROW'); hash.update(row.line).update('\n'); rows++; }
        if (chunk.length < 250) break;
      }
    } finally { await client.query(`CLOSE ${cursor}`); }
    tables.push({ schema, name, rows, sha256: hash.digest('hex') });
  }
  const sequences: Record<string, unknown>[] = [];
  const sequenceRows = (await client.query(`SELECT n.nspname AS schema,c.relname AS name,s.seqstart::text,s.seqincrement::text,s.seqmin::text,s.seqmax::text,s.seqcache::text,s.seqcycle
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_sequence s ON s.seqrelid=c.oid
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"`)).rows;
  for (const sequence of sequenceRows) {
    const state = (await client.query(`SELECT last_value::text,is_called FROM ${quoteIdentifier(String(sequence.schema))}.${quoteIdentifier(String(sequence.name))}`)).rows[0];
    sequences.push({ ...sequence, ...state });
  }
  const structuralCatalog = (await client.query(`SELECT to_jsonb(x) AS item FROM (
    SELECT 'column' AS kind,n.nspname AS schema,c.relname AS parent,a.attname AS name,jsonb_build_object('position',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'default',pg_get_expr(d.adbin,d.adrelid)) AS detail
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped AND c.relkind IN('r','p') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'constraint',n.nspname,c.relname,k.conname,jsonb_build_object('definition',pg_get_constraintdef(k.oid,true),'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'index',n.nspname,c.relname,i.relname,jsonb_build_object('definition',pg_get_indexdef(i.oid)) FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class c ON c.oid=x.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'function',n.nspname,'',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',jsonb_build_object('definition',pg_get_functiondef(p.oid),'securityDefiner',p.prosecdef,'config',p.proconfig) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prokind IN('f','p') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'relation-security',n.nspname,c.relname,c.relname,jsonb_build_object('rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN('r','p') AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'policy',n.nspname,c.relname,p.polname,jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT jsonb_agg(CASE WHEN v=0 THEN 'PUBLIC' ELSE pg_get_userbyid(v) END ORDER BY v) FROM unnest(p.polroles) v),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'trigger',n.nspname,c.relname,t.tgname,jsonb_build_object('definition',pg_get_triggerdef(t.oid,true),'enabled',t.tgenabled) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
  ) x ORDER BY kind COLLATE "C",schema COLLATE "C",parent COLLATE "C",name COLLATE "C"`)).rows.map(row => row.item as Record<string, unknown>);
  const securityCatalog = (await client.query(`SELECT to_jsonb(x) AS item FROM (
    SELECT 'schema-acl' AS kind,n.nspname AS schema,''::text AS name,jsonb_build_object('owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl) AS detail FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'relation-acl',n.nspname,c.relname,jsonb_build_object('owner',pg_get_userbyid(c.relowner),'acl',c.relacl) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'column-acl',n.nspname,c.relname||'.'||a.attname,jsonb_build_object('acl',a.attacl) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'function-acl',n.nspname,p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',jsonb_build_object('owner',pg_get_userbyid(p.proowner),'acl',p.proacl,'securityDefiner',p.prosecdef) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    UNION ALL SELECT 'default-acl',COALESCE(n.nspname,''),pg_get_userbyid(d.defaclrole)||':'||d.defaclobjtype::text,jsonb_build_object('owner',pg_get_userbyid(d.defaclrole),'acl',d.defaclacl) FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
    UNION ALL SELECT 'role','',r.rolname,jsonb_build_object('superuser',r.rolsuper,'inherit',r.rolinherit,'createRole',r.rolcreaterole,'createDb',r.rolcreatedb,'login',r.rolcanlogin,'replication',r.rolreplication,'bypassRls',r.rolbypassrls,'config',r.rolconfig) FROM pg_roles r
  ) x ORDER BY kind COLLATE "C",schema COLLATE "C",name COLLATE "C"`)).rows.map(row => row.item as Record<string, unknown>);
  return { format: 1, hashMethod: 'SHA-256 of UTF-8 to_jsonb(row)::text sorted COLLATE C, each followed by LF; owners/ACL separate.', tables, sequences, structuralCatalog, securityCatalog };
}

