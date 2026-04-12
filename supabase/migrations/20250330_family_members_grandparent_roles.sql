-- 祖辈角色：由 爷爷/奶奶/外公/外婆 改为配偶侧表述（与 App 一致）
UPDATE public.family_members SET role = '丈夫父亲' WHERE role = '爷爷';
UPDATE public.family_members SET role = '丈夫母亲' WHERE role = '奶奶';
UPDATE public.family_members SET role = '妻子父亲' WHERE role = '外公';
UPDATE public.family_members SET role = '妻子母亲' WHERE role = '外婆';
