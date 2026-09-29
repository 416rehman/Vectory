-- Small metadata expression indexes keep the default state/sort reads away
-- from configuration bodies. Search is a literal substring, so it may scan
-- metadata candidates; page projection remains bounded.
CREATE INDEX configuration_library_state_updated ON records(kind,COALESCE(json_type(data,'$.archived')='true',0),json_extract(data,'$.updated_at') DESC,json_extract(data,'$.name') COLLATE NOCASE,id) WHERE kind='configuration';
CREATE INDEX configuration_library_state_name ON records(kind,COALESCE(json_type(data,'$.archived')='true',0),json_extract(data,'$.name') COLLATE NOCASE,id) WHERE kind='configuration';
CREATE INDEX configuration_library_updated ON records(kind,json_extract(data,'$.updated_at') DESC,json_extract(data,'$.name') COLLATE NOCASE,id) WHERE kind='configuration';
CREATE INDEX configuration_library_name ON records(kind,json_extract(data,'$.name') COLLATE NOCASE,id) WHERE kind='configuration';
