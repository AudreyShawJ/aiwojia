/**
 * Figma 设计令牌 — 全局 UI 配色（蓝紫主色体系）
 * 业务代码请优先从此处引用，避免各页硬编码分叉。
 */
export const colors = {
  primary: '#5A6CFF',
  accent: '#7C8BFF',
  background: '#F6F7F9',
  card: '#FFFFFF',
  foreground: '#1F1F1F',
  mutedForeground: '#8E8E93',
  primaryForeground: '#FFFFFF',
  destructive: '#FF3B30',
  border: 'rgba(31, 31, 31, 0.06)',
  muted: '#F0F1F3',
  /** 分割线、Markdown hr 等 */
  hairline: 'rgba(31, 31, 31, 0.08)',
} as const;

/** 产品对外名称与登录/启动页文案（与正式 Logo、Figma 一致） */
export const brand = {
  productName: '家厘',
  splashTagline: '把家的点滴，慢慢变成可用的记忆',
  loginWelcomeSubtitle: '欢迎回来，登录你的账户',
  registerInviteSubtitle: '创建账户，开始记录家庭生活',
} as const;

/**
 * 分类标签色（未来感配色）
 * health / child / vehicle / finance 与 Figma 一致；其余与主色系协调。
 */
export const categoryColors: Record<string, string> = {
  health: '#FF6B6B',
  child: '#4ECDC4',
  vehicle: '#A78BFA',
  finance: '#FFA94D',
  house: '#54A0FF',
  relationship: '#FF8FAB',
  admin: '#7C8BFF',
  plant_pet: '#5AAE6B',
  daily: '#8E8E93',
};
