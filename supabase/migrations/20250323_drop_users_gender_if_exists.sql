-- 若曾执行过含 users.gender 的旧版迁移，可运行本脚本删除该列（亲属视角改由 family_members 角色推断）
ALTER TABLE public.users DROP COLUMN IF EXISTS gender;
