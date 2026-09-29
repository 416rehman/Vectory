CREATE INDEX deployment_history_recent ON records(kind,created_at DESC,id ASC) WHERE kind='deployment';
CREATE INDEX deployment_history_status ON records(kind,json_extract(data,'$.status'),created_at DESC,id ASC) WHERE kind='deployment';
CREATE INDEX deployment_history_scheduled ON records(kind,(json_extract(data,'$.scheduled_at') IS NOT NULL),created_at DESC,id ASC) WHERE kind='deployment';
CREATE INDEX deployment_history_status_scheduled ON records(kind,json_extract(data,'$.status'),(json_extract(data,'$.scheduled_at') IS NOT NULL),created_at DESC,id ASC) WHERE kind='deployment';
CREATE INDEX deployment_targets_state ON deployment_targets(deployment_id,state);
