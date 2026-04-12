/**
 * 登录页《隐私政策》《用户服务协议》展示用结构化正文
 */
export type LegalBlock =
  | { type: 'title'; text: string }
  | { type: 'intro'; text: string }
  | { type: 'section'; title: string }
  | { type: 'p'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'numbered'; items: string[] };

export const PRIVACY_POLICY_BLOCKS: LegalBlock[] = [
  {
    type: 'intro',
    text: '我们非常重视您的个人信息和家庭数据安全，请您在使用本服务前仔细阅读本政策。',
  },
  { type: 'section', title: '一、我们收集的信息' },
  { type: 'p', text: '为提供服务，我们可能收集以下信息：' },
  { type: 'p', text: '1. 基本信息' },
  {
    type: 'bullets',
    items: ['手机号 / 账号信息', '设备信息（用于安全与优化）'],
  },
  { type: 'p', text: '2. 用户主动提供的数据' },
  { type: 'p', text: '包括但不限于：' },
  {
    type: 'bullets',
    items: [
      '家庭成员信息',
      '上传的文件、图片、视频、音频',
      '聊天记录与输入内容',
      '提醒、日程、财务记录',
    ],
  },
  { type: 'section', title: '二、数据使用方式' },
  { type: 'p', text: '我们仅在以下场景使用您的数据：' },
  {
    type: 'bullets',
    items: [
      '提供核心功能（记录、提醒、查询等）',
      'AI 处理与结果生成（如分类、提取、解析）',
      '优化产品体验',
    ],
  },
  { type: 'section', title: '三、核心隐私承诺' },
  { type: 'p', text: '我们郑重承诺：' },
  {
    type: 'numbered',
    items: [
      '所有用户数据均采用加密存储',
      '不会将用户数据用于模型训练',
      '不会向任何第三方出售或共享数据',
      '不会用于广告或商业变现用途',
      '用户可随时导出或删除全部数据',
    ],
  },
  { type: 'section', title: '四、数据存储与安全' },
  {
    type: 'numbered',
    items: [
      '数据采用行业标准加密技术进行存储与传输',
      '严格限制内部访问权限',
      '采取合理措施防止数据泄露、篡改或丢失',
    ],
  },
  { type: 'section', title: '五、数据共享与披露' },
  { type: 'p', text: '我们不会主动共享您的数据，除非：' },
  {
    type: 'bullets',
    items: ['获得您的明确授权', '法律法规要求'],
  },
  { type: 'section', title: '六、用户权利' },
  { type: 'p', text: '您拥有以下权利：' },
  {
    type: 'bullets',
    items: ['查询和访问数据', '修改和更正数据', '删除数据', '导出数据', '撤回授权'],
  },
  { type: 'section', title: '七、数据删除' },
  { type: 'p', text: '当您：' },
  {
    type: 'bullets',
    items: ['主动删除数据', '注销账号'],
  },
  {
    type: 'p',
    text: '我们将在合理期限内删除或匿名化处理相关数据。',
  },
  { type: 'section', title: '八、未成年人保护' },
  {
    type: 'p',
    text: '若涉及未成年人信息，应由监护人同意并指导使用。',
  },
  { type: 'section', title: '九、政策更新' },
  {
    type: 'p',
    text: '本隐私政策可能根据业务发展进行更新，更新后将及时通知用户。',
  },
];

export const TERMS_OF_SERVICE_BLOCKS: LegalBlock[] = [
  {
    type: 'intro',
    text:
      '欢迎使用「家厘」（以下简称「本服务」）。在使用本服务前，请您仔细阅读并充分理解本协议的全部内容。您在注册、登录或使用本服务时，即视为已同意本协议。',
  },
  { type: 'section', title: '一、服务内容' },
  {
    type: 'p',
    text:
      '本服务是一款基于人工智能技术的家庭管理工具，旨在帮助用户记录、整理及管理家庭相关信息，包括但不限于：',
  },
  {
    type: 'bullets',
    items: [
      '家庭成员信息管理',
      '文件、图片、视频等资料存储',
      '提醒与日程管理',
      '财务记录与分析',
      'AI 问答与信息检索',
    ],
  },
  { type: 'section', title: '二、账号与家庭体系' },
  {
    type: 'numbered',
    items: [
      '用户需通过手机号或其他方式注册账号，并对账号行为负责',
      '用户可创建或加入「家庭」，家庭内成员可根据权限共享数据',
      '用户应合理设置权限，避免信息误共享',
    ],
  },
  { type: 'section', title: '三、用户数据与责任' },
  {
    type: 'numbered',
    items: [
      '用户对其上传、输入、存储的所有内容承担全部责任',
      '用户不得上传违法、侵权、违规或不当内容',
      '用户应确保其拥有上传内容的合法权利',
    ],
  },
  { type: 'section', title: '四、AI 能力说明' },
  {
    type: 'numbered',
    items: [
      '本服务基于人工智能模型生成内容，仅供参考',
      'AI 输出可能存在不准确或不完整的情况',
      '用户应自行判断信息的适用性，平台不承担因使用 AI 结果产生的风险',
    ],
  },
  { type: 'section', title: '五、服务使用规范' },
  {
    type: 'p',
    text: '用户不得利用本服务从事以下行为：',
  },
  {
    type: 'bullets',
    items: [
      '违法违规行为',
      '数据滥用或恶意攻击',
      '侵犯他人隐私或权益',
      '干扰系统正常运行',
    ],
  },
  {
    type: 'p',
    text: '如有违反，本平台有权限制或终止服务。',
  },
  { type: 'section', title: '六、服务变更与中断' },
  {
    type: 'numbered',
    items: [
      '本平台可根据需要调整服务内容',
      '因系统维护、升级等原因可能导致服务中断',
      '平台将尽力保障服务稳定性',
    ],
  },
  { type: 'section', title: '七、免责声明' },
  { type: 'p', text: '在法律允许范围内：' },
  {
    type: 'bullets',
    items: [
      '本服务按「现状」提供',
      '不保证服务完全无误或不中断',
      '不对因使用服务造成的损失承担责任',
    ],
  },
  { type: 'section', title: '八、协议变更' },
  {
    type: 'p',
    text: '本协议可能根据业务发展进行调整，更新后将在平台公布。',
  },
];
