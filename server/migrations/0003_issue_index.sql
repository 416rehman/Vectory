CREATE INDEX issue_device_lookup ON records(json_extract(data,'$.device_id')) WHERE kind='issue';
