-- Fence out in-flight scans when a Spender is deleted and later re-created.
-- Generated per rule, never reused after an intentional re-add.
ALTER TABLE spender_rules ADD COLUMN generation TEXT NOT NULL DEFAULT '';
UPDATE spender_rules SET generation=lower(hex(randomblob(16))) WHERE generation='';
ALTER TABLE spender_history_jobs ADD COLUMN generation TEXT NOT NULL DEFAULT '';
UPDATE spender_history_jobs SET generation=(SELECT generation FROM spender_rules WHERE spender=spender_history_jobs.spender)
WHERE generation='' AND EXISTS(SELECT 1 FROM spender_rules WHERE spender=spender_history_jobs.spender);
