-- reminders.event_date：存用户指定的事项时刻（带时区）；原为 date 的按上海 00:00 解释
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'reminders'
      AND column_name = 'event_date'
      AND udt_name = 'date'
  ) THEN
    ALTER TABLE public.reminders
      ALTER COLUMN event_date TYPE timestamptz USING (
        CASE
          WHEN event_date IS NULL THEN NULL
          ELSE ((event_date::text || ' 00:00:00')::timestamp AT TIME ZONE 'Asia/Shanghai')
        END
      );
    COMMENT ON COLUMN public.reminders.event_date IS '事项/到点时刻（用户指定，timestamptz）；仅存日期意图时需结合业务默认钟点（如 7:00）写入完整时刻';
  END IF;
END $$;
