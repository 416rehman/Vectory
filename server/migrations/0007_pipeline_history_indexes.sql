CREATE INDEX revision_pipeline_sequence ON records(kind,json_extract(data,'$.configuration_id'),CAST(json_extract(data,'$.revision') AS INTEGER) DESC) WHERE kind='revision';
CREATE INDEX version_pipeline_sequence ON records(kind,json_extract(data,'$.configuration_id'),CAST(json_extract(data,'$.number') AS INTEGER) DESC) WHERE kind='version';
