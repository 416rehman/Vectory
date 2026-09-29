UPDATE records
SET data=json_insert(data,'$.archived',json('false'),'$.archived_at',json('null'))
WHERE kind='configuration';
