import { GRANDPARENT_ROLES } from '@/constants/familyMemberRoles';

export type KinshipMemberRow = { name: string; role: string; linked_user_id?: string | null };

function inferGenderFromMemberRoleString(role: string): 'male' | 'female' | null {
  const r = (role || '').trim();
  if (!r) return null;
  if (r === GRANDPARENT_ROLES.husbandFather || r === GRANDPARENT_ROLES.wifeFather) return 'male';
  if (r === GRANDPARENT_ROLES.husbandMother || r === GRANDPARENT_ROLES.wifeMother) return 'female';
  if (/^(丈夫|老公|先生)$/.test(r)) return 'male';
  if (/^(妻子|老婆|太太)$/.test(r)) return 'female';
  if (/父亲|爸爸/.test(r)) return 'male';
  if (/母亲|妈妈/.test(r)) return 'female';
  return null;
}

/**
 * 根据家庭成员「角色」推断丈夫/妻子视角（用于公婆、岳父母等规则）。
 * 若存在 **linked_user_id 关联行**，只读该行角色，不再按显示名猜行。
 */
export function inferUserGenderFromFamilyMemberRole(
  members: KinshipMemberRow[],
  currentUserName: string,
  linkedMember: { name: string; role: string } | null
): 'male' | 'female' | null {
  const rLinked = (linkedMember?.role || '').trim();
  if (rLinked) {
    return inferGenderFromMemberRoleString(rLinked);
  }
  const n = (currentUserName || '').trim();
  if (!n) return null;
  const row = members.find(m => (m.name || '').trim() === n);
  if (!row) return null;
  return inferGenderFromMemberRoleString(row.role || '');
}

/**
 * 注入到抽取/分类 Prompt：亲属指代与 related_member 填写规则（与产品拍板一致）
 * @param linkedMember 当前账户在 family_members 上已关联的那一行；有则身份以该行为准，不得再按昵称猜行。
 */
export function buildKinshipRulesForPrompt(
  members: KinshipMemberRow[],
  currentUserName: string,
  linkedMember: { name: string; role: string } | null
): string {
  const userGender = inferUserGenderFromFamilyMemberRole(members, currentUserName, linkedMember);
  const hasChild = members.some(m => {
    const r = (m.role || '').toLowerCase();
    return /儿子|女儿|孩子|宝宝|娃|小孩|儿童|宝贝/.test(r) || /儿子|女儿|孩子/.test(m.name);
  });

  const lines: string[] = ['【亲属与 related_member 规则】'];

  if (hasChild) {
    lines.push(
      '- 家庭成员列表中**有孩子**时：「妻子父亲、妻子母亲、丈夫父亲、丈夫母亲」等祖辈以**孩子**为参照填写 related_member（填具体称呼或列表中的名字）。',
      '- 用户本人说「我妈」「我爸」默认指**用户自己的父母**，应映射到家庭成员列表中**与用户同辈父母角色**的成员名（如「妈妈」「爸爸」条目），**不要**将「我妈」误标为孩子的妻子母亲，除非用户明确说「孩子外婆」「娃的外婆」等。'
    );
  } else {
    lines.push('- 家庭成员列表中**无孩子**时：按**当前用户**视角解析称谓。');
    if (userGender === 'male') {
      lines.push(
        '- 当前用户为**男性**：用户说「我老婆的妈妈」「丈母娘」「岳母」→ related_member 填配偶母亲对应成员名；「我妈」→ 用户母亲对应成员名（勿标成妻子母亲）。'
      );
    } else if (userGender === 'female') {
      lines.push(
        '- 当前用户为**女性**：用户说「我老公的妈妈」「婆婆」「婆家妈」→ related_member 填配偶母亲对应成员名；「我妈」→ 用户母亲对应成员名（勿标成妻子母亲）。'
      );
    } else {
      if (linkedMember) {
        lines.push(
          '- 当前用户**已关联**成员条目，身份以关联行为准。若关联角色无法映射到丈夫/妻子：`我妈/我爸` 只映射到列表中明确的父母类成员名；**不要猜测**「丈母娘/婆婆」等配偶父母称谓，除非用户原话已明确。'
        );
      } else {
        lines.push(
          '- 当前用户**未关联**成员条目：可结合账户显示名与列表**谨慎推测**丈夫/妻子视角；仍不确定时「我妈/我爸」只映射到明确的父母角色成员，不要强猜配偶父母称谓。'
        );
      }
    }
  }

  lines.push(
    '- related_member 尽量填家庭成员列表中的**具体姓名**（与列表「名字」一致）；用户说「我妈」时映射到其父母对应条目姓名，**避免**在多人可称「妈妈」时只写模糊称呼，便于其他家人阅读记录时对应到人。'
  );

  if (linkedMember) {
    lines.push(
      `- **账号已关联家庭成员**：「${linkedMember.name}（${linkedMember.role}）」——此为当前说话人在家庭中的**唯一身份依据**，**禁止**再按账户昵称去匹配其它成员行来代表用户。`
    );
  } else {
    const genderNote =
      userGender === 'male'
        ? '男（按显示名同名行或列表推断）'
        : userGender === 'female'
          ? '女（按显示名同名行或列表推断）'
          : '未能可靠推断丈夫/妻子视角';
    lines.push(
      `- 当前说话用户显示名：${currentUserName || '未知'}；**未关联成员**，视角：${genderNote}（抽取时可适度推测，用语保守）。`
    );
  }
  return lines.join('\n');
}

/**
 * 主对话 system：锚定「你」与亲属视角。已关联成员时禁止关系错乱；未关联时允许保守推测。
 */
export function buildConversationPerspectiveBlock(
  currentUserDisplayName: string,
  linkedMember: { name: string; role: string } | null
): string {
  const n = (currentUserDisplayName || '').trim();

  if (linkedMember) {
    const lmName = linkedMember.name;
    const lmRole = linkedMember.role;
    return `【当前对话者（「你」的唯一所指）· **已关联家庭成员**】
- 登录账户显示名（可能与成员姓名不同）：**${n || '未知'}**。
- 该账户已在 App 内**绑定**家庭成员条目：**${lmName}（${lmRole}）** —— 这是当前用户在家庭中的**唯一身份依据**，回答中所有「你」的亲属关系换算**必须**与「${lmRole}」一致。
- **禁止**再假设当前用户是列表里其它人；**禁止**把公婆/岳父母、父母子女关系说反或套错视角；**禁止**用英文字母、编号、「用户A/B」指代当前用户。
- 若严格依据关联角色与上文仍无法唯一确定某人是谁，请**明确说明不确定**，**不要编造**关系。

【亲属称谓视角换算· **已关联：须严格，禁止错乱**】
- 记录可能由配偶先说（如妻子说「我婆婆」）。「婆婆/公公」= 妻子对**丈夫父母**的说法。若当前用户关联角色为**丈夫**，对同一位长辈只能说「你的妈妈/父亲」等，**绝对不得**说「你的婆婆/公公」。
- 「丈母娘/岳父/岳母」等 = 丈夫对**妻子父母**的说法。若当前用户关联角色为**妻子**，对同一人只能说「你的妈妈/父亲」等，**不得**说「你的丈母娘/岳父」。
- 先把记录里的称呼还原成「这位亲属是谁的父母」，再按**关联角色**换成当前用户口语中的正确叫法。
- 用户问「她/他是我的谁」：锁定「她」指谁后，**只按关联身份**回答；可一句点明「你爱人在记录里称 Ta…，按你的身份 Ta 是你的…」。
- 结合上方【家庭近期记录】中的**记录人**：记录里的「我妈、我的妈妈」先相对**记录人**理解，再换算成对当前「你」的称呼，**禁止**默认当成你的父母。

【禁止亲属推断】
家庭成员列表里没有某个人的条目时，绝对禁止通过推断来凑答案。
例如：列表里有「张三（妻子父亲）」，不能推断出「妻子母亲」「岳母」等未列出的人。
找不到对应人时，只能说「这位家人还没有在 App 里建档」，
不能用列表里的其他人代替。`;
  }

  return `【当前对话者（「你」的唯一所指）· **未关联家庭成员**】
- 正在对话的账户显示名：**${n || '未知'}**；该账户**尚未**在「家庭成员」里绑定具体条目。
- 「你」指当前登录使用者。禁止用英文字母、编号、「用户A/B」指 Ta；勿把其他成员姓名当成对当前提问者的称呼。
- 推断用户在家庭中的视角（丈夫/妻子等）时**允许结合**显示名与成员列表**合理猜测**，但须**保守**（可用「若你这边是…」「不太确定的话…」）；**不要**把推测当事实断言。

【亲属称谓视角换算· **未关联：可推测**】
- 同上条公婆/岳父母原则，但仅当你能从上下文**合理推断**当前用户是丈夫还是妻子时再换算；推断不稳时直接说明「需要你在家庭成员里关联本人账号后我能更准确」或分情况简述。
- 须结合【家庭近期记录】的**记录人**理解「我妈」等指代，勿默认等于当前听众的父母。

【禁止亲属推断】
家庭成员列表里没有某个人的条目时，绝对禁止通过推断来凑答案。
例如：列表里有「张三（妻子父亲）」，不能推断出「妻子母亲」「岳母」等未列出的人。
找不到对应人时，只能说「这位家人还没有在 App 里建档」，
不能用列表里的其他人代替。`;
}

/**
 * 说明「家庭近期记录」里记录人前缀的含义，避免把记录人视角下的「我妈」误答成听众的「你妈」。
 */
export function buildFamilyHistoryProvenanceRules(): string {
  return `【家庭近期记录 / 今日记录的读法】
- 每条里的「记录人：某某（角色）」表示**该条由这位家庭成员登录账户时写入**。文中的「我妈、我爸、我的妈妈」等是**相对该记录人**的亲属，**不得**默认等于当前提问者（你）的父母。
- **禁止**仅凭成员列表里仅有「妻子父亲/妻子母亲」等祖辈，就把记录中的「我妈/我爸」说成那位祖辈：**标题里的第一人称父母用语以记录人视角为准**，与行首「某某：」前缀冲突时**以标题指代与系统注为准**，勿把祖辈姓名当成「我妈」所指。
- 若行末带有〔→**当前提问者为妻子/丈夫**…〕类**系统注**，你必须**逐字遵守**，对妻子**禁止**答「你的爸爸/你的妈妈」指丈夫的父母；对丈夫**禁止**把妻子父母的记录说成「你的爸爸/你的妈妈」。
- 回答「谁患病/谁有什么事」：先根据**记录人**弄清涉事成员在家庭中的身份，再换成**对当前对话者**的称呼。例：记录人为妻子且内容为「我的妈妈…」、丈夫在问 → 须说成「你爱人的妈妈」或成员表中的具体姓名/「岳母」等，**禁止**说成「你的妈妈」，除非可证明与听众父母是同一成员。
- 记录人为「账户·未关联成员」时仅知昵称，可结合成员列表保守推断，不确定则说明。`;
}
