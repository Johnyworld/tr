-- 이벤트 로그와 대화 기록은 append-only다. 수정·삭제를 막는다.
CREATE TRIGGER `events_no_update` BEFORE UPDATE ON `events` BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `events_no_delete` BEFORE DELETE ON `events` BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `transcript_no_update` BEFORE UPDATE ON `transcript` BEGIN SELECT RAISE(ABORT, 'transcript is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `transcript_no_delete` BEFORE DELETE ON `transcript` BEGIN SELECT RAISE(ABORT, 'transcript is append-only'); END;
