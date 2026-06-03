ALTER TABLE `part` ADD `data_model` text;
--> statement-breakpoint
UPDATE part
SET data_model = json_remove(data, '$.state.metadata')
WHERE length(CAST(data AS BLOB)) > 65536
  AND json_extract(data, '$.type') = 'tool'
  AND json_extract(data, '$.state.status') = 'completed'
  AND length(CAST(json_extract(data, '$.state.metadata') AS BLOB)) > 65536;
