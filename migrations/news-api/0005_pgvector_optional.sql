-- pgvector is optional (spec §5.3). Where this database role may create the extension, enable it
-- and index post_embeddings for cosine distance. Where it may not (SiteGround: insufficient_privilege)
-- or the extension isn't installed (undefined_file), skip both and leave search in text mode.
-- A DBA can run the same two statements later: docs/deploy/siteground.md, "pgvector and the search mode".
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE INDEX IF NOT EXISTS post_embeddings_embedding_hnsw_idx
    ON post_embeddings USING hnsw ((embedding::vector(1536)) vector_cosine_ops);
EXCEPTION
  WHEN insufficient_privilege OR undefined_file THEN
    RAISE NOTICE 'pgvector unavailable (%): semantic search stays off', SQLSTATE;
END
$$;
