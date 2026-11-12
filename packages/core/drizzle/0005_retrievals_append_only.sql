-- 검색 기록도 append-only다
CREATE TRIGGER `retrievals_no_update` BEFORE UPDATE ON `retrievals` BEGIN SELECT RAISE(ABORT, 'retrievals is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `retrievals_no_delete` BEFORE DELETE ON `retrievals` BEGIN SELECT RAISE(ABORT, 'retrievals is append-only'); END;
