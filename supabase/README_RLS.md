# Supabase RLS 安全修复说明

## 问题
Supabase 安全扫描提示：多个 `public` 表未启用行级安全（RLS），存在数据暴露风险。

## 处理步骤

### 1. 在 Supabase 执行 SQL 迁移

1. 打开 [Supabase Dashboard](https://supabase.com/dashboard)
2. 选择你的项目
3. 左侧菜单进入 **SQL Editor**
4. 新建查询，将 `supabase/migrations/20250309_enable_rls.sql` 的完整内容粘贴进去
5. 点击 **Run** 执行

### 2. 后续补丁：`users` 同家庭可读

若「家庭成员 → APP 账户」看不到其他成员：在 **SQL Editor** 中执行 `supabase/migrations/20250324_users_select_same_family.sql`（或合并进你的迁移流程）。  
该策略允许同一 `family_id` 下的用户互相 `SELECT` 对方 `users` 行，与 `users_select_own` 并存。

**若执行后出现「家庭成员列表、APP 账户全空」**：多半是旧版策略在 `users` 的 RLS 里子查询了 `users`，触发 **infinite recursion**。请再执行一次**修正后的** `20250324` 全文，或执行 `20250325_users_same_family_rls_hotfix.sql`（会创建 `current_user_family_id()` + 重建策略）。

### 3. 验证

执行完成后，在 Dashboard 的 **Database** → **Tables** 中，每个表应显示 RLS 已启用（绿色勾选）。

安全扫描中的相关警示应消失。

### 4. 代码变更说明

- **`app/setup.tsx`**：加入家庭时，由直接查询 `families` 表改为调用 RPC `get_family_by_invite_code`，以在 RLS 下正确完成加入流程。

### 5. 若执行报错

- **“policy already exists”**：说明之前已执行过，可忽略或先删除对应 policy 再执行
- **“relation does not exist”**：某些表（如 `records`、`event_versions`）可能不存在，迁移中的 `DO` 块会跳过
- **“column family_id does not exist”**：`invitations` 或 `records` 表结构不同，迁移会使用 `authenticated` 策略兜底

### 6. 回滚（如需）

如需临时关闭某表的 RLS：

```sql
ALTER TABLE public.表名 DISABLE ROW LEVEL SECURITY;
```

注意：回滚会重新引入安全风险，仅用于排查问题。
