/*
  01 — Catalog. Run in EACH legacy database (Gcpe.Hub, Gcpe.NewsOnDemand, Gcpe.NewsDistribution,
  BCNewsOnDemandAdminTool, and any other GCPE database on the server). Part B runs once per server.
  Read-only; returns no personal data. See README.md.
*/
SET NOCOUNT ON;
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;

/* ---------- PART A: this database ---------- */

-- 1.1 Server and database settings.
SELECT @@SERVERNAME AS server_name, @@VERSION AS sql_server_version, DB_NAME() AS db,
       d.compatibility_level, d.collation_name, d.recovery_model_desc, d.create_date,
       d.is_read_committed_snapshot_on, d.snapshot_isolation_state_desc,
       SERVERPROPERTY('Collation') AS server_collation,
       (SELECT CAST(SUM(size) * 8 / 1024.0 AS DECIMAL(12,1)) FROM sys.database_files) AS size_mb,
       SYSDATETIMEOFFSET() AS run_at,
       DATENAME(TZOFFSET, SYSDATETIMEOFFSET()) AS server_utc_offset_now        -- Q19
FROM sys.databases d WHERE d.name = DB_NAME();

-- 1.2 Every table and column.
SELECT s.name AS schema_name, t.name AS table_name, c.column_id, c.name AS column_name,
       ty.name AS data_type, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity,
       c.is_computed, c.collation_name, dc.definition AS default_definition
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.columns c ON c.object_id = t.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
ORDER BY s.name, t.name, c.column_id;

-- 1.3 Row counts and sizes per table.
SELECT s.name AS schema_name, t.name AS table_name, SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows END) AS row_count,
       CAST(SUM(a.total_pages) * 8 / 1024.0 AS DECIMAL(12,1)) AS size_mb,
       t.create_date, t.modify_date
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.partitions p ON p.object_id = t.object_id
JOIN sys.allocation_units a ON a.container_id = p.partition_id
GROUP BY s.name, t.name, t.create_date, t.modify_date
ORDER BY row_count DESC;

-- 1.4 Primary keys, unique constraints and indexes.
SELECT s.name AS schema_name, t.name AS table_name, i.name AS index_name, i.type_desc,
       i.is_primary_key, i.is_unique, i.is_unique_constraint, i.has_filter, i.filter_definition,
       STUFF((SELECT ', ' + c.name + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END
                     + CASE WHEN ic.is_included_column = 1 THEN ' (incl)' ELSE '' END
                FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
               WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id
               ORDER BY ic.is_included_column, ic.key_ordinal FOR XML PATH('')), 1, 2, '') AS columns
FROM sys.indexes i
JOIN sys.tables t ON t.object_id = i.object_id
JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE i.type > 0
ORDER BY s.name, t.name, i.index_id;

-- 1.5 Foreign keys.
SELECT fk.name AS fk_name, SCHEMA_NAME(tp.schema_id) + '.' + tp.name AS from_table, cp.name AS from_column,
       SCHEMA_NAME(tr.schema_id) + '.' + tr.name AS to_table, cr.name AS to_column,
       fk.delete_referential_action_desc, fk.update_referential_action_desc, fk.is_disabled, fk.is_not_trusted
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id
JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id
JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
ORDER BY from_table, fk.name;

-- 1.6 Check constraints.
SELECT SCHEMA_NAME(t.schema_id) + '.' + t.name AS table_name, cc.name, cc.definition, cc.is_disabled
FROM sys.check_constraints cc JOIN sys.tables t ON t.object_id = cc.parent_object_id
ORDER BY table_name;

-- 1.7 Source of every view, procedure, function and trigger (code, not data).
SELECT SCHEMA_NAME(o.schema_id) AS schema_name, o.name, o.type_desc, o.create_date, o.modify_date,
       m.definition
FROM sys.objects o JOIN sys.sql_modules m ON m.object_id = o.object_id
WHERE o.is_ms_shipped = 0
ORDER BY o.type_desc, schema_name, o.name;

-- 1.8 References to other databases or servers from this database's code.
SELECT DISTINCT OBJECT_SCHEMA_NAME(d.referencing_id) + '.' + OBJECT_NAME(d.referencing_id) AS referencing_object,
       d.referenced_server_name, d.referenced_database_name, d.referenced_schema_name, d.referenced_entity_name
FROM sys.sql_expression_dependencies d
WHERE d.referenced_database_name IS NOT NULL OR d.referenced_server_name IS NOT NULL
ORDER BY referencing_object;

-- 1.9 Synonyms (often point at other databases).
SELECT SCHEMA_NAME(schema_id) AS schema_name, name, base_object_name FROM sys.synonyms;

-- 1.10 Database roles and which groups/service accounts are in them. Individual Windows users
--      are counted, not named.
SELECT r.name AS role_name,
       CASE WHEN m.type IN ('G', 'S', 'X', 'E') OR m.name LIKE '%svc%' OR m.name LIKE '%service%'
            THEN m.name ELSE '(individual user)' END AS member,
       m.type_desc AS member_type, COUNT(*) AS members
FROM sys.database_role_members rm
JOIN sys.database_principals r ON r.principal_id = rm.role_principal_id
JOIN sys.database_principals m ON m.principal_id = rm.member_principal_id
GROUP BY r.name,
         CASE WHEN m.type IN ('G', 'S', 'X', 'E') OR m.name LIKE '%svc%' OR m.name LIKE '%service%'
              THEN m.name ELSE '(individual user)' END, m.type_desc
ORDER BY r.name, member;

-- 1.11 Explicit permissions granted to roles/groups (app access patterns).
SELECT pr.name AS grantee, pr.type_desc, pe.permission_name, pe.state_desc,
       pe.class_desc, OBJECT_SCHEMA_NAME(pe.major_id) + '.' + OBJECT_NAME(pe.major_id) AS object_name
FROM sys.database_permissions pe
JOIN sys.database_principals pr ON pr.principal_id = pe.grantee_principal_id
WHERE pr.type IN ('R', 'G', 'S', 'X', 'E') AND pr.name NOT IN ('public', 'dbo', 'guest')
ORDER BY grantee, object_name;

-- 1.12 Full-text indexes.
SELECT OBJECT_SCHEMA_NAME(fi.object_id) + '.' + OBJECT_NAME(fi.object_id) AS table_name,
       c.name AS column_name, fc.name AS catalog_name
FROM sys.fulltext_indexes fi
JOIN sys.fulltext_index_columns fic ON fic.object_id = fi.object_id
JOIN sys.columns c ON c.object_id = fic.object_id AND c.column_id = fic.column_id
JOIN sys.fulltext_catalogs fc ON fc.fulltext_catalog_id = fi.fulltext_catalog_id;

/* ---------- PART B: once per server (needs read access to msdb) ---------- */

-- 2.1 SQL Agent jobs and schedules (e.g. who runs EmergencyInfo.exe, digests, purges).
SELECT j.name AS job_name, j.enabled, j.description, c.name AS category,
       s.name AS schedule_name, s.enabled AS schedule_enabled, s.freq_type, s.freq_interval,
       s.freq_subday_type, s.freq_subday_interval, s.active_start_time,
       (SELECT MAX(msdb.dbo.agent_datetime(h.run_date, h.run_time)) FROM msdb.dbo.sysjobhistory h
         WHERE h.job_id = j.job_id AND h.step_id = 0) AS last_run
FROM msdb.dbo.sysjobs j
LEFT JOIN msdb.dbo.syscategories c ON c.category_id = j.category_id
LEFT JOIN msdb.dbo.sysjobschedules js ON js.job_id = j.job_id
LEFT JOIN msdb.dbo.sysschedules s ON s.schedule_id = js.schedule_id
ORDER BY j.name;

-- 2.2 Job steps. Commands may hold credentials: lines naming a password are masked, but read
--     this result before sending.
SELECT j.name AS job_name, st.step_id, st.step_name, st.subsystem, st.database_name,
       CASE WHEN st.command LIKE '%password%' OR st.command LIKE '%pwd=%' OR st.command LIKE '%secret%'
            THEN '*** (mentions a credential; describe it instead)' ELSE st.command END AS command
FROM msdb.dbo.sysjobs j JOIN msdb.dbo.sysjobsteps st ON st.job_id = j.job_id
ORDER BY j.name, st.step_id;

-- 2.3 Linked servers (names and products only).
SELECT name, product, provider, data_source, is_linked FROM sys.servers WHERE server_id > 0;

-- 2.4 Every database on the server (to spot GCPE databases we don't know about).
SELECT name, create_date, compatibility_level, state_desc,
       (SELECT CAST(SUM(size) * 8 / 1024.0 AS DECIMAL(12,1)) FROM sys.master_files mf WHERE mf.database_id = d.database_id) AS size_mb
FROM sys.databases d ORDER BY name;
