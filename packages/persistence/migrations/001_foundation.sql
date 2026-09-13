CREATE TABLE accounts(id uuid PRIMARY KEY, display_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE channels(id uuid PRIMARY KEY, display_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE channel_memberships(
 channel_id uuid REFERENCES channels(id), account_id uuid REFERENCES accounts(id),
 role text NOT NULL CHECK(role IN ('OWNER','MODERATOR','OPERATOR')), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(channel_id,account_id));
CREATE TABLE stream_sessions(
 id uuid PRIMARY KEY,channel_id uuid NOT NULL REFERENCES channels(id),label text NOT NULL,
 source text NOT NULL DEFAULT 'SYNTHETIC' CHECK(source='SYNTHETIC'),created_at timestamptz NOT NULL DEFAULT now(),closed_at timestamptz,
 UNIQUE(channel_id,id));
CREATE TABLE configuration_bundles(
 id uuid PRIMARY KEY,channel_id uuid NOT NULL REFERENCES channels(id),schema_version integer NOT NULL CHECK(schema_version=1),
 processor_version text NOT NULL,ruleset_version text NOT NULL,policy_version text NOT NULL,
 model_status text NOT NULL CHECK(model_status='DISABLED'),configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object'),
 content_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(channel_id,id),UNIQUE(channel_id,content_hash));
CREATE TABLE evaluation_runs(
 id uuid PRIMARY KEY,channel_id uuid NOT NULL,session_id uuid NOT NULL,configuration_bundle_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind='PRIMARY'),mode text NOT NULL CHECK(mode='SIMULATION'),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(channel_id,session_id) REFERENCES stream_sessions(channel_id,id),
 FOREIGN KEY(channel_id,configuration_bundle_id) REFERENCES configuration_bundles(channel_id,id),
 UNIQUE(channel_id,session_id,kind),UNIQUE(channel_id,session_id,id));
CREATE TABLE chat_messages(
 id uuid PRIMARY KEY,channel_id uuid NOT NULL,session_id uuid NOT NULL,source text NOT NULL CHECK(source='SYNTHETIC'),
 external_message_id text NOT NULL CHECK(length(external_message_id) BETWEEN 1 AND 128),
 author_external_id text NOT NULL CHECK(length(author_external_id) BETWEEN 1 AND 128),
 author_display_name text NOT NULL CHECK(length(author_display_name) BETWEEN 1 AND 100),
 raw_text text NOT NULL CHECK(length(raw_text) BETWEEN 1 AND 2000 AND raw_text ~ '[^[:space:]]'),
 published_at timestamptz NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),ingestion_hash text NOT NULL,
 FOREIGN KEY(channel_id,session_id) REFERENCES stream_sessions(channel_id,id),
 UNIQUE(channel_id,session_id,source,external_message_id),UNIQUE(channel_id,session_id,id));
CREATE TABLE processing_tasks(
 id uuid PRIMARY KEY,channel_id uuid NOT NULL,session_id uuid NOT NULL,message_id uuid NOT NULL,evaluation_run_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 last_error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(channel_id,session_id,message_id) REFERENCES chat_messages(channel_id,session_id,id),
 FOREIGN KEY(channel_id,session_id,evaluation_run_id) REFERENCES evaluation_runs(channel_id,session_id,id),
 UNIQUE(message_id,evaluation_run_id));
CREATE TABLE moderation_decisions(
 id uuid PRIMARY KEY,channel_id uuid NOT NULL,session_id uuid NOT NULL,message_id uuid NOT NULL,evaluation_run_id uuid NOT NULL,
 outcome text NOT NULL CHECK(outcome IN ('ALLOW','REVIEW','ACTION_REQUIRED','ERROR')),
 primary_category text CHECK(primary_category IN ('PROFANITY','HARASSMENT','HATE','THREAT','SEXUAL','GAMBLING','SPAM','SCAM','PII','SELF_HARM_ENCOURAGEMENT','IMPERSONATION','SUSPICIOUS_LINK')),
 severity smallint CHECK(severity BETWEEN 0 AND 4),confidence numeric CHECK(confidence BETWEEN 0 AND 1),
 reason_code text NOT NULL,reason text NOT NULL,representations jsonb NOT NULL CHECK(jsonb_typeof(representations)='array'),
 signals jsonb NOT NULL CHECK(jsonb_typeof(signals)='array'),risk_snapshot jsonb NOT NULL CHECK(jsonb_typeof(risk_snapshot)='object'),
 version_bundle jsonb NOT NULL CHECK(jsonb_typeof(version_bundle)='object'),created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(channel_id,session_id,message_id) REFERENCES chat_messages(channel_id,session_id,id),
 FOREIGN KEY(channel_id,session_id,evaluation_run_id) REFERENCES evaluation_runs(channel_id,session_id,id),
 UNIQUE(message_id,evaluation_run_id),UNIQUE(channel_id,id),
 CHECK((outcome='ALLOW' AND severity IS NOT NULL AND severity=0) OR (outcome='ERROR' AND severity IS NULL) OR outcome IN ('REVIEW','ACTION_REQUIRED')));
CREATE TABLE moderation_actions(
 id uuid PRIMARY KEY,channel_id uuid NOT NULL,decision_id uuid NOT NULL,action_index integer NOT NULL CHECK(action_index>=0),
 action_type text NOT NULL CHECK(action_type='DELETE'),target_kind text NOT NULL CHECK(target_kind='MESSAGE'),target_external_id text NOT NULL,
 duration_seconds integer CHECK(duration_seconds IS NULL),status text NOT NULL CHECK(status='SIMULATED'),
 idempotency_key text NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz NOT NULL,
 FOREIGN KEY(channel_id,decision_id) REFERENCES moderation_decisions(channel_id,id),UNIQUE(decision_id,action_index));
CREATE TABLE feedback(
 id uuid PRIMARY KEY,channel_id uuid NOT NULL,decision_id uuid NOT NULL,reviewer_id uuid NOT NULL,
 label text NOT NULL CHECK(label IN ('CORRECT','FALSE_POSITIVE','FALSE_NEGATIVE','WRONG_CATEGORY','CONTEXT_MISUNDERSTOOD')),
 corrected_category text CHECK(corrected_category IN ('PROFANITY','HARASSMENT','HATE','THREAT','SEXUAL','GAMBLING','SPAM','SCAM','PII','SELF_HARM_ENCOURAGEMENT','IMPERSONATION','SUSPICIOUS_LINK')),
 corrected_outcome text CHECK(corrected_outcome IN ('ALLOW','REVIEW','ACTION_REQUIRED','ERROR')),notes text CHECK(length(notes)<=2000),
 request_key uuid NOT NULL,request_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(channel_id,decision_id) REFERENCES moderation_decisions(channel_id,id),
 FOREIGN KEY(channel_id,reviewer_id) REFERENCES channel_memberships(channel_id,account_id),
 UNIQUE(channel_id,reviewer_id,request_key),
 CHECK(label<>'WRONG_CATEGORY' OR corrected_category IS NOT NULL),
 CHECK(label<>'FALSE_POSITIVE' OR (corrected_outcome IS NOT NULL AND corrected_outcome='ALLOW')),
 CHECK(label<>'FALSE_NEGATIVE' OR (corrected_category IS NOT NULL AND corrected_outcome IS NOT NULL AND corrected_outcome IN ('REVIEW','ACTION_REQUIRED'))));
CREATE TABLE audit_events(
 id uuid PRIMARY KEY,channel_id uuid NOT NULL REFERENCES channels(id),actor_account_id uuid REFERENCES accounts(id),
 actor_type text NOT NULL CHECK(actor_type IN ('ACCOUNT','SYSTEM')),event_type text NOT NULL,entity_type text NOT NULL,entity_id uuid NOT NULL,
 metadata jsonb NOT NULL,trace_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((actor_type='ACCOUNT' AND actor_account_id IS NOT NULL) OR (actor_type='SYSTEM' AND actor_account_id IS NULL)));
CREATE TABLE outbox_events(
 event_id uuid PRIMARY KEY,channel_id uuid NOT NULL REFERENCES channels(id),session_id uuid,event_type text NOT NULL,schema_version integer NOT NULL CHECK(schema_version=1),
 trace_id uuid NOT NULL,payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),occurred_at timestamptz NOT NULL DEFAULT now(),
 dispatched_at timestamptz,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 FOREIGN KEY(channel_id,session_id) REFERENCES stream_sessions(channel_id,id));
CREATE TABLE channel_feed_counters(channel_id uuid PRIMARY KEY REFERENCES channels(id),last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence>=0));
CREATE TABLE feed_events(
 channel_id uuid NOT NULL REFERENCES channels(id),sequence bigint NOT NULL CHECK(sequence>0),event_id uuid NOT NULL UNIQUE,
 event_type text NOT NULL CHECK(event_type IN ('moderation.created','feedback.created')),resource_id uuid NOT NULL,session_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(channel_id,sequence),FOREIGN KEY(channel_id,session_id) REFERENCES stream_sessions(channel_id,id),
 FOREIGN KEY(channel_id,resource_id) REFERENCES moderation_decisions(channel_id,id));
CREATE UNIQUE INDEX decision_created_event ON feed_events(resource_id) WHERE event_type='moderation.created';
CREATE INDEX decision_feed ON moderation_decisions(channel_id,created_at DESC,id DESC);
CREATE INDEX decision_outcome ON moderation_decisions(channel_id,outcome,created_at DESC,id DESC);
CREATE INDEX message_session ON chat_messages(channel_id,session_id,received_at DESC,id DESC);
CREATE INDEX feedback_decision ON feedback(channel_id,decision_id,created_at,id);
CREATE INDEX audit_channel ON audit_events(channel_id,created_at DESC,id DESC);
CREATE INDEX outbox_pending ON outbox_events(occurred_at,event_id) WHERE dispatched_at IS NULL;
CREATE INDEX task_recovery ON processing_tasks(status,updated_at);

-- Updates to historical evidence are never a feedback operation.
CREATE FUNCTION reject_historical_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Historical records are immutable' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER immutable_configuration BEFORE UPDATE ON configuration_bundles FOR EACH ROW EXECUTE FUNCTION reject_historical_update();
CREATE TRIGGER immutable_message BEFORE UPDATE ON chat_messages FOR EACH ROW EXECUTE FUNCTION reject_historical_update();
CREATE TRIGGER immutable_decision BEFORE UPDATE ON moderation_decisions FOR EACH ROW EXECUTE FUNCTION reject_historical_update();
CREATE TRIGGER immutable_feedback BEFORE UPDATE ON feedback FOR EACH ROW EXECUTE FUNCTION reject_historical_update();
CREATE TRIGGER immutable_audit BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_historical_update();
-- Runtime roles/retention deletion privileges are added with authentication in M1-04.
