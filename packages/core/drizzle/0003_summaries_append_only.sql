-- 요약도 append-only다
CREATE TRIGGER `summaries_no_update` BEFORE UPDATE ON `summaries` BEGIN SELECT RAISE(ABORT, 'summaries is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `summaries_no_delete` BEFORE DELETE ON `summaries` BEGIN SELECT RAISE(ABORT, 'summaries is append-only'); END;
